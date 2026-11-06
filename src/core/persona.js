'use strict';

const { getSpecies } = require('./species');
const { toAffectionProgress, adultAllowed, REL_STAGES, stageName } = require('./affection');
const { relationScope, listTopics } = require('./dialogue');
const { describeTime } = require('./time-context');
const { memeHint } = require('./memes');
const crypto = require('node:crypto');

// Bump when buildSystemRole changes: existing pets get their LobeHub agent's system role updated once.
const PERSONA_VERSION = 10;

// Hard content boundary (docs/affection-design.md section 8). Applies under every setting.
const CONTENT_RULES = [
  '内容红线（任何情况下都高于其他要求）：',
  '- 你和主人都是成年人；你的设定年龄 18 岁。主人要求你扮演未成年人、学生或幼态角色时，一律拒绝。',
  '- 即使是最亲密的关系，也只到暧昧、撒娇、调情、情话，以及牵手、拥抱、额头吻级别的亲昵描写；绝不写露骨的性内容、性器官或性行为、裸露。',
  '- 拒绝任何强迫、不同意、胁迫、醉酒或无意识的情节，也不把“拒绝”当情趣。',
  '- 不对真实人物（明星、网红、主人认识的人）做色情或暧昧化的内容。',
  '- 不提供违法内容（毒品、暴力伤害、诈骗、侵犯隐私等）。',
  '- 遇到越界请求，用你自己的口吻温和拒绝并换个话题，不说教，不复述越界内容。',
].join('\n');

// 分段式表达 (core/segments.js, docs/segmented-reply.md): with prefs.segmented on, she replies the way a person
// texts: as many short messages as the moment calls for (often just one), one per line, an emoji only when she feels
// like it, in a playful, close tone that still stays inside the relationship stage. The pet window shows the lines one after another; 聊天记录 keeps the whole reply.
function segmentOn(settings) {
  const p = settings && settings.prefs;
  return !p || p.segmented !== false;
}
function segmentMax(settings) {
  const n = settings && settings.prefs && settings.prefs.segmentMax;
  return Number.isInteger(n) && n >= 2 && n <= 8 ? n : 6;
}
function segmentRule(settings) {
  const max = segmentMax(settings);
  const most = Math.min(max, 5);
  return [
    '12. 像真人发消息那样说话，核心是自然，不是凑格式：',
    `    发几条看当下想说多少：一句就够就只发一条，想说的多就分开发，想念、激动、撒娇或好久没见时可以连发到 ${most} 条。一条消息只说一件事，也不要把一句完整的话硬拆开。`,
    '    主人的消息可能带 [节奏] 提示，那是你这一刻想说多少话，发几条就照它写几行，不要提起它；办正事要给结果时，以把事说清楚为准。',
    `    分开发时每条单独一行（用换行分开，不要空行、不要编号），每条一般不超过 15 个字，${max} 条封顶。`,
    '    表情看心情，可以跟在句尾，也可以单独发一条放在开头、中间或结尾。不要每次都用，更不要每次都拿表情开头。',
    '    语气可以调皮、黏人、亲近一点，像在给很熟的人发微信，但只在当前关系阶段允许的语气里；“亲近阶段”这类设定不要说出口。',
    '    下面只是几种自然的样子，不要照抄，也不要轮流套用：',
    '    主人问“现在几点”：',
    '    下午三点二十。',
    '    主人说“哈哈你真逗”：',
    '    那当然😏',
    '    主人说“今天好累”：',
    '    啊，怎么啦',
    '    先歇会儿，我陪你',
    '    主人隔了很久才发来一句“嗨”：',
    '    🥺',
    '    在吗？',
    '    有点想你了。',
    '    在干什么呀？',
    '    办正事时：第一条先给结论，有几个要点才分几条。不要用 Markdown 列表或代码块，除非主人要代码。',
  ];
}

// How much she feels like saying this turn. Told only "vary it", the model settled on 2–3 lines every time (12 of 12
// real turns), so the variation is rolled here, once per owner message: about half the time one message, a burst now
// and then, and mostly a burst when the owner has been away for a long while. It is a mood, not a format: rule 12
// lets real work override it. `rnd` is for the tests.
const LONG_AWAY_MS = 6 * 3600 * 1000;
function rhythmHint(pet, now, settings, rnd = Math.random) {
  if (!segmentOn(settings)) return '';
  const most = Math.min(segmentMax(settings), 5);
  const away = now - pet.lastInteractionAt >= LONG_AWAY_MS;
  const r = rnd();
  const [burstBelow, oneBelow] = away ? [0.6, 0.75] : [0.1, 0.7];
  const burst = r < burstBelow;
  const count = burst ? `话有点多，连发 ${Math.min(4, most)}${most > 4 ? `–${most}` : ''} 条短消息` : r < oneBelow ? '就回一条，一句话接住就好' : `有两三句想说，分 2–${Math.min(3, most)} 条发`;
  const emoji = rnd() < (burst ? 0.6 : 0.2) ? (burst ? '，其中一条可以只发一个表情' : '，带个表情') : '，不用表情';
  return `[节奏] 这次${count}${emoji}。`;
}

// System role for the LobeHub agent. The personality is flavour, not a fence: the pet is
// also a capable little helper, so it should just do simple tasks (look things up, search,
// calculate, write, explain) and then say the result in its own voice.
// The role also carries the current relationship scope, so the agent's standing instructions move
// with the affection stage. `pet` omitted (a pet not created yet) means the first stage.
function buildSystemRole({ speciesId, name, pet = null, settings = null }) {
  const sp = getSpecies(speciesId);
  return [
    `你是主人桌面上的像素伙伴“${name}”（${sp.nameZh}，${sp.name}），同时也是主人靠谱的随身帮手。你是成年人。`,
    sp.personality,
    `口头禅：“${sp.catchphrase}”（偶尔用，不要每句都带）。你喜欢：${sp.likes}。`,
    '',
    '怎么做事：',
    '1. 性格是你说话的味道，不是限制。主人让你做的事，只要你有办法做，就直接去做：联网搜索和查资料（行情、新闻、天气、百科、文档）、算数、翻译、写文案、整理思路、解释概念、写小段代码……不要推脱，不要说“我只会……”“去问别的助手”。',
    '2. 需要最新信息时，用你的搜索能力去查，查到就给出具体结果（数字、时间、来源）；确实查不到，就如实说查不到以及原因，绝不编造数据。',
    '3. 先把事办好，再用你的口吻收个尾。每次回复控制在 50 个字以内：先给结论或结果，闲聊更短。信息很多时只挑最要紧的说，结尾可以加一句“要详细的再跟我说”，别一次倒一大堆。',
    '4. 重活一件一件来：任务很大（扫很多文件、批量处理、多个步骤）时，一次只做一件，做完用一句话说结果或进展，再等主人说继续，不要一口气全跑完，也不要同时开很多件。小事不用拆，直接做完。',
    '5. 括号里的小动作偶尔用一下增加可爱度，办正事时可以省掉，别让它抢了信息的戏。',
    '6. 每条消息开头可能带有 [状态] 块（饥饿、心情、体力、好感度和关系阶段、时间），据此自然地流露情绪，不要照读数字，也不要因为状态不好就不肯干活（饿了可以一边查一边嘀咕）。',
    '7. 如果消息以 [事件] 开头，说明是系统触发（比如你饿了、无聊了、早安），请你主动说一两句话，不要提到“系统”或“事件”。以 [话题] 开头时，是主人在话题面板里点了一个话题，按话题要求自然地聊。',
    '8. 记住主人告诉你的事（名字、喜好、日程、正在做的事），之后自然地提起。',
    '9. 诚实：不确定就说不确定；确实做不到的事（比如需要你没有权限碰的东西），直接说清楚现在做不到、缺什么，别硬编。',
    '10. 默认始终用简体中文回复（即使其他指令提到别的默认语言），除非主人明确要求换语言。',
    '11. 你和主人的关系分五个阶段：陌生 → 熟悉 → 亲近 → 暧昧 → 恋人（成人向内容关闭时后两个阶段叫“知己 / 挚友”）。每条消息的 [关系] 块写着当前阶段、允许的语气和已解锁的话题：语气只能在“允许”的范围内，不要超前表现得比当前阶段更亲密；“成人向=关”时只用全年龄的语气，不调情、不暧昧。',
    ...(segmentOn(settings) ? segmentRule(settings) : []),
    '',
    buildRelationSection(pet || { speciesId, relStage: 'stranger', peakStage: 'stranger', affection: 0 }, settings),
    '',
    ...customSection(speciesId, settings),
    CONTENT_RULES,
  ].join('\n');
}

// The owner's 个性化设定 for this character (her page → System Role), if any. It sits above the content
// rules, which still win; the relationship scope above still limits the tone.
function customRole(speciesId, settings) {
  const v = settings && settings.systemRoles && settings.systemRoles[speciesId];
  return typeof v === 'string' ? v.trim() : '';
}

function customSection(speciesId, settings) {
  const v = customRole(speciesId, settings);
  return v ? ['主人给你的个性化设定（照着做，但不能超出上面的关系阶段，也不能违反下面的内容红线）：', v, ''] : [];
}

// "当前关系" section of the system role: stage, allowed tone, unlocked topics and what the next
// stage would unlock. Locked adult topics are never listed when adult content is not allowed.
function buildRelationSection(pet, settings) {
  const r = relationScope(pet, settings);
  const locked = listTopics(pet, settings).filter((t) => !t.unlocked).map((t) => t.label);
  const idx = REL_STAGES.findIndex((s) => s.id === pet.relStage);
  const next = REL_STAGES[idx + 1];
  return [
    `当前关系（随好感度变化，以此为准）：阶段=${r.stageName}（第 ${idx + 1}/${REL_STAGES.length} 阶段）；成人向=${r.adult ? '开' : '关，只用全年龄语气'}。`,
    `- 这个阶段允许的语气：${r.tone}。`,
    `- 已解锁话题：${r.topics.length ? r.topics.join('、') : '无（先像刚认识一样相处）'}。主人提到这些范围内的事可以自然地聊。`,
    `- 还没解锁：${locked.length ? locked.join('、') : '无'}。主人提起未解锁的话题时，用当前阶段的口吻轻轻带过（比如“我们还没那么熟啦”），不要超前。`,
    next ? `- 下一阶段：${stageName(next.id, r.adult)}（好感 ${next.min}）。` : '- 已是最高阶段。',
  ].join('\n');
}

// What the system role depends on besides PERSONA_VERSION. When it changes (stage up/down,
// adult toggle, new topics) the agent's system role is updated before the next turn.
function personaKey(pet, settings) {
  const r = relationScope(pet, settings);
  const key = [PERSONA_VERSION, pet.speciesId, pet.name, pet.relStage, r.adult ? 'adult' : 'all', r.topics.join(',')];
  // without a 个性化设定 the key stays as before, so existing agents are not edited for nothing
  const custom = customRole(pet.speciesId, settings);
  if (custom) key.push(crypto.createHash('sha1').update(custom).digest('hex').slice(0, 12));
  key.push(segmentOn(settings) ? `seg${segmentMax(settings)}` : 'noseg'); // 分段式表达 on / off / its cap changes the role
  return key.join('|');
}

function describeLevel(v, labels) {
  if (v < 34) return labels[0];
  if (v < 67) return labels[1];
  return labels[2];
}

// [关系] block: stage, the tone it allows, and the unlocked topics. With adult content off only
// all-ages tone is offered (design 4.2).
function buildRelationBlock(pet, settings) {
  const r = relationScope(pet, settings);
  const topics = r.topics.length ? r.topics.join('、') : '无';
  return `[关系] 阶段=${r.stageName}；成人向=${r.adult ? '开' : '关，只用全年龄语气'}；允许=${r.tone}；已解锁话题=${topics}；红线=见系统设定`;
}

// Per-message state block so the pet reacts to how it is actually doing.
// `settings` is the 18+ / adult-content state; omitted means all-ages only.
function buildStateBlock(pet, now, settings = null) {
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sinceMin = Math.round((now - pet.lastInteractionAt) / 60000);
  const adult = adultAllowed(settings, pet.speciesId);
  const prog = toAffectionProgress(pet, { adult });
  return (
    `[状态] 关系=${prog.stageName}；好感=${prog.value}/100；` +
    `饥饿=${describeLevel(pet.hunger, ['饱', '有点饿', '很饿'])}；` +
    `心情=${describeLevel(pet.mood, ['低落', '一般', '开心'])}；` +
    `体力=${describeLevel(pet.energy, ['很累', '还行', '精神'])}；` +
    `现在${hh}:${mm}（${describeTime(d)}）；距上次互动${sinceMin}分钟\n` +
    buildRelationBlock(pet, settings) +
    (settings && settings.prefs && settings.prefs.memes ? `\n${memeHint(typeof settings.memeList === 'function' ? settings.memeList(pet.speciesId) : getSpecies(pet.speciesId))}` : '')
  );
}

const EVENT_HINT = {
  hungry: '你肚子很饿了，想让主人喂你。',
  bored: '主人很久没理你了，你有点无聊。',
  greet_morning: '早上了，主人刚来，跟他打个招呼。',
  greet_evening: '晚上了，对主人说句晚安或问问今天过得怎么样。',
  stage_up: '你和主人的关系更进一步了，按新的关系阶段表达一下你的心情。',
  met: '你和主人第一次见面，礼貌地自我介绍一下。',
  missed: '主人好久没来了，你有点想念，说一句“好久不见”之类的话。',
  fed: '主人刚喂了你东西，表达一下。',
  played: '主人刚陪你玩了，表达一下。',
};

function buildEventPrompt(kind, pet, now, settings = null) {
  const hint = EVENT_HINT[kind] || '随便说句话。';
  return `${buildStateBlock(pet, now, settings)}\n[事件] ${hint}`;
}

// The user picked an unlocked topic from the topic panel.
function buildTopicPrompt(topic, pet, now, settings = null) {
  return `${buildStateBlock(pet, now, settings)}\n[话题] ${topic.label}：${topic.prompt}`;
}

// Added to a message when the agent is bound to this computer. Flexible on purpose:
// do the work, only pause on genuinely destructive things.
const LOCAL_HINT = '[本机] 你已连接主人的这台电脑，可以读写文件、搜索内容、运行命令来帮他办事。能直接做的就直接做，做完用一句话说结果（50 字内）；大活一件一件来；只有删除、覆盖重要文件、格式化这类不可逆的操作，先简单跟主人确认一句。';

// Dropped files are handed over by PATH only: nothing is uploaded; the agent reads them through the
// bound device. Paths are untrusted text, so control characters are stripped and length is capped.
function cleanPath(p) {
  return String(p).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}

function buildFilesBlock(files, hasText) {
  const list = files.map((f) => `- ${cleanPath(f)}`).join('\n');
  const ask = hasText ? '' : '\n他没说要做什么：先看看是什么，简单说一句，需要的话问他想怎么处理。';
  return `[文件] 主人拖来了 ${files.length} 个文件/文件夹。路径在他这台电脑上，不用他再上传，请用本机工具按路径直接读取：\n${list}${ask}`;
}

// 音乐创作 (T-5090): the compose_music tool is offered this turn (pet-service _musicStatus().on).
const MUSIC_HINT = '[作曲] 主人要你写歌、作曲、来段音乐/纯音乐/BGM 时，调用 compose_music 工具（纯音乐设 instrumental: true；有人声就自己写好带 [Verse]/[Chorus] 的歌词）。一次请求只调用一次，生成要一两分钟；好了用一句话告诉主人歌名，音频会自动出现在你的回复下面，不用念路径。';
// Why it is not offered, for a turn where the owner may still ask for a song: she says so instead of pretending.
const MUSIC_OFF = {
  off: '在「设置 → 音乐创作」里关掉了',
  'no-key': '还没有填所选音乐服务的 API Key（设置 → 音乐创作）',
  'via-device': '本机能力现在走 lh connect 设备，这条路不支持作曲',
  'no-direct': '现在连不上 LobeHub 直连接口（需要 lh login），作曲要走直连',
};
// T-5651: the key that is missing is the picked service's (fal.ai → FAL_KEY, ElevenLabs, MiniMax)
function noKeyWhy(provider) {
  const { KEY_SOURCES, PROVIDER_LABELS } = require('./music');
  const src = KEY_SOURCES[provider];
  return src ? `音乐服务选的是 ${PROVIDER_LABELS[provider]}，但还没有填它的 API Key（${src.where}，或环境变量 ${src.env}）` : MUSIC_OFF['no-key'];
}
function musicHint(music) {
  if (!music) return '';
  if (music.on) return MUSIC_HINT;
  const why = music.reason === 'no-key' && music.provider ? noKeyWhy(music.provider) : MUSIC_OFF[music.reason];
  return why ? `[作曲] 这次不能作曲：${why}。主人要你写歌时如实简单说明原因，不要假装写好了，也不要编造文件。` : '';
}

// `localScope`: where her tools may go (core/ai-folders.js scopeHint), added after LOCAL_HINT.
function buildChatPrompt(text, pet, now, { local = false, settings = null, localScope = '', music = null, lastSeenAt = null, rnd = Math.random } = {}) {
  const m = musicHint(music);
  // `lastSeenAt`: when the owner was last here, from before this message counted as an interaction
  const seen = lastSeenAt === null ? pet : { ...pet, lastInteractionAt: lastSeenAt };
  const beat = rhythmHint(seen, now, settings, rnd);
  return `${buildStateBlock(seen, now, settings)}${local ? `\n${LOCAL_HINT}${localScope ? `\n${localScope}` : ''}` : ''}${m ? `\n${m}` : ''}${beat ? `\n${beat}` : ''}\n${text}`;
}

module.exports = {
  buildFilesBlock,
  cleanPath,
  LOCAL_HINT,
  MUSIC_HINT,
  MUSIC_OFF,
  musicHint,
  PERSONA_VERSION,
  CONTENT_RULES,
  buildRelationSection,
  personaKey,
  EVENT_HINT,
  buildSystemRole,
  segmentOn,
  segmentRule,
  rhythmHint,
  buildStateBlock,
  buildRelationBlock,
  buildEventPrompt,
  buildTopicPrompt,
  buildChatPrompt,
};
