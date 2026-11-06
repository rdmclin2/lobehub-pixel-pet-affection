'use strict';
// 她的房间 · 聊天里说「回床上休息吧」(docs/illustrated-room.md §4, design §8.2): recognise what the owner asks her to
// do in her room from what they typed. A plain order is matched here with rules (free, instant, works offline, the
// same way as core/dance-intent.js). Everything else goes to the decision model (core/room-chat.js through
// buildDecision / readDecision, `lh generate decide`), and the engine carries out its answer; her reply is written
// after that, knowing what happened. Only while her room is open in the game window.
// Pure; UMD (window.RoomIntent in the game page, require() in main and the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // the words every room understands, per activity (a room adds its own: manifest rooms[].intents)
  const WORDS = {
    sleep: ['回床上', '上床', '去睡', '睡觉', '睡吧', '睡一会', '睡会', '躺下', '躺着', '躺一会', '休息吧', '去休息', '休息一下', '歇着吧', '补个觉'],
    work: ['工作', '干活', '写代码', '打开电脑', '开电脑', '用电脑', '上网', '写作业', '学习', '加班', '写周报', '码字'],
    phone: ['看手机', '玩手机', '刷手机', '拿手机', '刷微博', '刷朋友圈', '回消息'],
    music: ['听歌', '听音乐', '放首歌', '放歌', '放音乐', '来首歌', '听首歌', '戴耳机'],
    game: ['打游戏', '玩游戏', '开一局', '打一局', '来一局', '玩会游戏', '打会游戏', '玩把游戏', '打把游戏', '上分'],
    idle: ['发呆', '发会儿呆', '发会呆', '发一会儿呆', '歇会', '歇一会', '犯懒', '坐着', '坐一会', '坐会儿', '什么都别做', '放空', '摸鱼'],
  };
  // what a screen plays, and the words for it
  const SCREEN_WORDS = {
    clips: ['刷抖音', '抖音', '刷视频', '短视频', '看视频', '刷快手', '看b站', '刷b站'],
    page: ['网页', '搜一下', '查一下', '搜索', '百度', '查查'],
    player: ['放歌', '听歌', '放首歌', '听音乐', '放音乐'],
    game: ['打游戏', '玩游戏'],
  };
  // the activity a screen word leads to when nothing else says where: 刷抖音 alone → the phone in bed;
  // 「打开电脑刷抖音」 → the desk (电脑 is named)
  const SCREEN_HOME = { clips: 'phone', page: 'work', player: 'music', game: 'game' };
  const COMPUTER_RE = /电脑|笔记本|桌前|书桌/;
  const LAMP_ON_RE = /开灯|开台灯|打开台灯|把灯打开|把台灯打开|灯打开|开一下灯|亮灯/;
  const LAMP_OFF_RE = /关灯|关台灯|把灯关|把台灯关|灯关了|灯关掉|关掉台灯|关一下灯|熄灯/;
  // a stop: 别玩了 / 不玩了 / 别刷了 / 停下 / 别看了 / 放下手机
  const STOP_RE = /(别|不要|不|甭|先别)再?(玩|刷|看|弄|干|打|听)[^，。！？,.!?]{0,4}(了|啦)|停下|停一下|放下手机|关掉电脑|关电脑|合上电脑/;
  // a word preceded by one of these (within 3 characters, same clause) is not asked for: 不想睡 / 别玩手机了 / 没在工作
  const NEG_RE = /(不想|不要|不用|不能|不会|不许|别|没|甭|不)$/;
  // a question about what she does is not an order: 你睡了吗 / 在工作么 — unless it also says do it (吧 / 去 / 快 …)
  const QUESTION_RE = /吗|(?<!什)么|嘛|[？?]|是不是|有没有|在不在/;
  const IMPERATIVE_RE = /吧|去|快|帮我|给我|现在|先|一下|来|赶紧|马上|要不|回|该/;
  // the owner talking about themselves: 我在看手机 / 我今天工作好多
  const SELF_RE = /^我(在|刚|也|正在|要|想|今天|还|都|已经|最近)/;
  // a short message is an order by itself (「听歌」「打开电脑刷抖音」); a longer one needs 吧 / 去 / 现在 …
  const SHORT = 8;
  const SEARCH_RE = /(?:搜一下|查一下|搜索|搜搜|查查|百度一下|百度)\s*([^，。！？,.!?]{1,24})/;
  const NEXT_RE = /下一个|换一个|下一条|换一条|划走|往下划/;
  // words that make a sentence an order to her; anything else holding an activity word (「工作好累啊」「我累了想睡觉」)
  // is for the model to judge
  const ORDER_RE = /吧|帮我|给我|赶紧|马上|现在|快去|^去|^来|^先|^回|^快/;
  const FILLER_RE = /[，。！？,.!?、~～…\s]|了|呀|啊|呢|嘛|哦|啦|一下/g;

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  // 「看会儿手机」「打一会游戏」「放一首歌」 say the same as 看手机 / 打游戏 / 放首歌: looked up without the filler
  const plain = (t) => t.replace(/(看|玩|刷|听|打|写)一?会儿?/g, '$1').replace(/(放|听|来)一首/g, '$1首').replace(/(玩|打)一把/g, '$1把');
  // every place a word occurs, and whether it is negated there
  function hits(text, word) {
    const out = [];
    for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
      const before = text.slice(Math.max(0, i - 3), i).split(/[，。！？,.!?、；;]/).pop();
      out.push({ at: i, end: i + word.length, negated: NEG_RE.test(before) || /^(不|别)/.test(text.slice(Math.max(0, i - 1), i)) });
    }
    return out;
  }
  // the vocabulary: the common words plus the room's (manifest rooms[].intents: { <state or activity>: [word…],
  // screen: { <content>: [word…] } })
  function vocab(roomIntents) {
    const states = {};
    for (const [k, ws] of Object.entries(WORDS)) states[k] = [...ws];
    const screens = {};
    for (const [k, ws] of Object.entries(SCREEN_WORDS)) screens[k] = [...ws];
    const ri = roomIntents && typeof roomIntents === 'object' ? roomIntents : {};
    for (const [k, ws] of Object.entries(ri)) {
      if (k === 'screen') { for (const [c, list] of Object.entries(ws || {})) if (Array.isArray(list)) screens[c] = [...new Set([...(screens[c] || []), ...list.map(norm)])]; continue; }
      if (!Array.isArray(ws)) continue;
      const own = ws.map(norm);
      // a word the room gives to one of its states is that state's, even when it is a common word of another
      // (犯懒 is a common word for 发呆; a room with its own 犯懒 picture takes it)
      for (const other of Object.keys(states)) if (other !== k) states[other] = states[other].filter((w) => !own.includes(w));
      states[k] = [...new Set([...(states[k] || []), ...own])];
    }
    return { states, screens };
  }

  // → { state, lamp, screen, query, stop, next, words } | null
  //   state   a state key or an activity (the room's state machine picks the state for an activity), or null
  //   lamp    true / false / null (not mentioned)
  //   screen  clips / page / player / game / null
  //   query   what to search for (搜一下明天天气 → 明天天气)
  //   stop    the owner asked her to stop what she is doing (→ back to her default state)
  //   next    下一个 / 换一个 while a screen plays clips
  // ctx: { state: the state she is in now, screen: what plays now }
  function matchRoomIntent(text, roomIntents = null, ctx = {}) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > 60) return null; // a long message is a conversation, not an order
    const t = norm(raw);
    const V = vocab(roomIntents);
    const said = plain(t);
    const isQuestion = QUESTION_RE.test(t) && !IMPERATIVE_RE.test(t);
    // states: the last word that is asked for (not negated) wins — 「先别玩游戏了，去睡觉」 → sleep
    let best = null;
    for (const [state, words] of Object.entries(V.states)) {
      for (const w of words) {
        if (!w) continue;
        for (const h of hits(said, w)) if (!h.negated && (!best || h.end > best.end || (h.end === best.end && w.length > best.len))) best = { state, end: h.end, len: w.length };
      }
    }
    let screen = null;
    let screenAt = -1;
    for (const [c, words] of Object.entries(V.screens)) for (const w of words) for (const h of hits(said, w)) if (!h.negated && h.end > screenAt) { screen = c; screenAt = h.end; }
    let lamp = null;
    if (LAMP_OFF_RE.test(t)) lamp = false;
    else if (LAMP_ON_RE.test(t)) lamp = true;
    const next = NEXT_RE.test(t) && ctx && ctx.screen === 'clips';
    const sm = t.match(SEARCH_RE);
    const query = sm ? sm[1].replace(/(吧|呀|啊|呢|嘛|看看|一下)+$/, '').trim() || null : null;
    // a screen word decides where she goes when it is on a device somewhere else: 「打开电脑刷抖音」 → work + clips
    let state = best ? best.state : null;
    if (screen === 'clips') {
      if (COMPUTER_RE.test(t)) state = 'work';
      else if (!state) state = SCREEN_HOME.clips;
      else if (state !== 'phone' && state !== 'work') screen = null; // 刷着抖音就睡着了: 睡觉
    } else if (screen === 'page') {
      if (!state) state = SCREEN_HOME.page;
      else if (state !== 'work' && state !== 'phone') screen = null;
    } else if (screen === 'player') {
      if (!state) state = SCREEN_HOME.player;
      else if (!['music', 'phone', 'work'].includes(state)) screen = null;
    } else if (screen === 'game') {
      if (!state) state = SCREEN_HOME.game;
      else if (state !== 'game') screen = null;
    }
    const stop = !state && STOP_RE.test(t);
    if (isQuestion && !next) return null;
    // an activity word in a sentence that does not ask for it: 「今天好累啊，工作好多」 / 「我在看手机」
    if (state && (SELF_RE.test(t) || (t.length > SHORT && !IMPERATIVE_RE.test(t)))) { state = null; screen = null; }
    if (!state && lamp === null && !stop && !next && !query) return null;
    // sure: nothing in the sentence but the order itself, or it says so in as many words. Not sure: the model judges
    let rest = said;
    for (const w of Object.values(V.states).concat(Object.values(V.screens)).flat().sort((a, b) => b.length - a.length)) if (w) rest = rest.split(w).join('');
    const sure = !state || ORDER_RE.test(t) || rest.replace(FILLER_RE, '').length <= 1;
    return { state, lamp, screen: screen || (query ? 'page' : null), query, stop, next, words: raw, sure };
  }

  // ---- the decision model: what the rules could not tell --------------------------------------------------------
  const DECISION_MIN = 0.6; // below this she stays where she is: a wrong move is worse than asking again
  const DECISION_MIN_QUESTION = 0.85; // 「大肥鱼，能收消息吗」: a question is talk unless the model is very sure (要不要来一把？)
  // room, now: the room, its view (state, label, lamp). → { questions, state } for `lh generate decide`. The choices
  // are the room's own states, so another room's pack needs nothing here.
  function buildDecision(room, now, text) {
    const criteria = {};
    for (const [k, s] of Object.entries((room && room.states) || {})) {
      if (s && !s.transient) criteria[k] = `主人叫她现在去「${s.label || k}」${s.doing ? `（${s.doing}）` : ''}`;
    }
    criteria.none = '不是在叫她换事情做：闲聊、问问题、感叹、说主人自己的事、夸她或说她、只是提到这件事、叫她别做某事';
    return {
      questions: {
        state: { type: 'choice', instructions: '主人在聊天里对房间里的她说了一句话。判断主人是不是要她现在换一件事做。只有明确或口语化地让她去做，才选那件事（「玩把游戏吧」「开黑吧」「该睡了」都算；「别动了，偷懒吧」这种先叫她别做再叫她做的，选后面那件）；拿不准就选 none。', criteria },
        lamp: { type: 'choice', instructions: '同一句话，判断主人是不是要她开或关台灯（嫌太暗、太亮也算）。', criteria: { on: '要她开灯', off: '要她关灯', none: '没有说灯的事' } },
      },
      state: `她现在：${(now && now.label) || (now && now.state) || ''}；台灯${now && now.lamp ? '开着' : '关着'}。\n主人说：${String(text).slice(0, 200)}`,
    };
  }
  // the model's answer to what the owner said (text) → { state, lamp } (null: stay / not mentioned), or null when the answer makes no sense
  function readDecision(res, room, text = '') {
    const a = res && res.answers;
    if (!a || !a.state || !a.lamp || typeof a.state.choice !== 'string') return null;
    const min = QUESTION_RE.test(norm(text)) ? DECISION_MIN_QUESTION : DECISION_MIN;
    const sure = (q) => (q.choice !== 'none' && Number(q.confidence) >= min ? q.choice : null);
    const state = sure(a.state);
    const lamp = sure(a.lamp);
    return { state: state && room && room.states && room.states[state] && !room.states[state].transient ? state : null, lamp: lamp === 'on' ? true : lamp === 'off' ? false : null };
  }

  // ---- what she said in her reply ---------------------------------------------------------------------------------
  // 「那我把灯也熄了」 with the lamp on: the picture follows what she said. Only a thing she did, sentence by sentence: not a
  // mention (台灯还亮着), a question (要不要关灯), what she did not do (没开灯 / 不关灯) or what the owner might do (你开灯吧).
  const SAID_OFF_RE = /(关|熄|灭)(掉|了|上)?台?灯|台?灯(也|都|就)?(给|被)?(关|熄|灭)(掉|了|上)/;
  const SAID_ON_RE = /(开|打开|点亮|拧亮|按亮|亮)(了|上)?(一下)?台?灯|台?灯(也|都|就)?(给|被)?(打开|开|点亮|亮)(了|上)/;
  const NOT_DONE_RE = /[没不别未甭]|要不|吗|么|？|\?|想|你|等|记得|待会|一会|如果|要是|的话|应该|可以|该/;
  function replyLampClaim(text) {
    let claim = null;
    for (const clause of String(text || '').split(/[，。！!~～…；;\n,]/)) {
      if (NOT_DONE_RE.test(clause)) continue;
      if (SAID_OFF_RE.test(clause)) claim = false;
      else if (SAID_ON_RE.test(clause)) claim = true;
    }
    return claim;
  }

  return { WORDS, SCREEN_WORDS, matchRoomIntent, vocab, buildDecision, readDecision, replyLampClaim };
});
