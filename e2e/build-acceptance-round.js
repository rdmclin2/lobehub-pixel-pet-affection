'use strict';
// Turns the artifacts of `e2e/run.js all` (out/e2e/results.json + files) into an `lh acceptance` round:
//   .acceptances/standalone-pixel-pet/<timestamp>-<slug>/{result.json,report.md,proposal.md,assets/}
// A check whose step did not run is `blocked`, a failed step is `fail`; nothing is invented.
// Report text is Chinese because the acceptance account's report language is zh-CN
// (`lh acceptance preflight` prints it; adjust this file if your account says otherwise).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'e2e');
const results = JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8'));

const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const slug = process.argv[2] || 'desktop-pet-round1';
const dir = path.join(ROOT, '.acceptances', 'standalone-pixel-pet', `${STAMP.slice(0, 8)}-${STAMP.slice(8)}-${slug}`);
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
if (!fs.existsSync(path.join(ROOT, '.acceptances', '.gitignore'))) fs.writeFileSync(path.join(ROOT, '.acceptances', '.gitignore'), '*\n');

// step spec: 'scenario:name prefix'
const find = (spec) => { const [sc, ...rest] = spec.split(':'); const sub = rest.join(':'); return results.find((r) => r.scenario === sc && r.name.startsWith(sub)); };
const copy = (file, description) => {
  const src = path.join(OUT, file);
  if (!file || !fs.existsSync(src)) return null;
  fs.copyFileSync(src, path.join(dir, 'assets', file));
  return { path: `assets/${file}`, description };
};

const TEXTS = {
  'run-log.txt': '端到端测试的完整控制台日志：每一步一行 PASS 或 FAIL，并带有实测数值。',
  'agent-view-excerpt.txt': '`lh agent view` 对刚创建的 agent 的输出（已去掉身份与工作区相关行），可见宠物名字与物种人设。',
  'chat-transcript.txt': '真实运行中每一条由模型生成的气泡文字及其来源标记，含主人发送的消息。',
  'release-check.txt': '放生宠物时，假 CLI 记录下的 `lh agent delete` 调用。',
  'release-check-live.txt': '放生后对原 agent id 执行 `lh agent view`，因 agent 已不存在而失败。',
};

const CHECKS = [
  { id: 'egg-choice', category: '首次启动', title: '首次启动提供四颗蛋供选择', steps: ['fresh:first launch shows four eggs'],
    method: '无存档启动应用，查看第一屏。', expected: '显示四颗像素蛋（火、水、草、鲸），选中前“孵化”按钮不可用。',
    ok: '第一屏出现四颗可区分的像素蛋，标注为火、水、草、鲸，“孵化”按钮为禁用状态。',
    shots: [['fresh:first launch shows four eggs', '首次启动窗口：四颗像素蛋，孵化按钮禁用。']] },
  { id: 'egg-select', category: '首次启动', title: '选中蛋后高亮并显示属性与性格介绍', steps: ['fresh:choosing an egg enables hatching'],
    method: '点击水之蛋并输入名字。', expected: '蛋高亮，显示属性和性格介绍，名字框可输入，“孵化”可用。',
    ok: '水之蛋被高亮，蛋下方显示介绍文字；名字框里是输入的名字，“孵化”可点。',
    shots: [['fresh:choosing an egg enables hatching', '选中水之蛋后的界面：蛋高亮、介绍文字、名字已填、孵化可用。']] },
  { id: 'login-flow', category: 'LobeHub 登录', title: '点击孵化会启动 LobeHub 登录并显示验证码', steps: ['fresh:hatching invokes lh login'],
    method: '未登录状态点击“孵化”（使用假 lh CLI，输出格式与真实 CLI 一致）。', expected: '进度页里登录步骤高亮，并显示验证码和链接。',
    ok: '进度页登录步骤被标为进行中，显示验证码 ABCD-1234 和验证链接。使用的是假 CLI，真实的浏览器登录未运行。',
    shots: [['fresh:hatching invokes lh login', '孵化进度页：登录步骤进行中、验证码框、裂开的蛋。']] },
  { id: 'pet-after-login', category: '创建 agent', title: '登录后创建宠物，并以所选名字和物种出现', steps: ['fresh:after login the agent is created and the pet appears', 'fresh:CLI call order'],
    method: '让假登录完成，观察应用。', expected: '宠物按所选名字出现并说出第一句话；CLI 调用顺序为 whoami、login、whoami、agent create、agent run。',
    ok: '水系宠物以所选名字出现，并带有第一句问候；记录到的 CLI 调用顺序一致，agent 创建时 system role 里带有物种人设。',
    shots: [['fresh:after login the agent is created and the pet appears', '孵化后的宠物界面：水系宠物与问候气泡。']], texts: ['run-log.txt'] },
  { id: 'persistence', category: '持久化', title: '重启应用后同一只宠物回来', steps: ['fresh:restart goes straight to the pet'],
    method: '关闭并用同一数据目录重新启动应用。', expected: '跳过选蛋，直接显示已保存的宠物。',
    ok: '重启后应用直接打开已保存的宠物，没有再出现选蛋界面。',
    shots: [['fresh:restart goes straight to the pet', '重启后的应用：直接显示已保存的宠物，不出现选蛋。']] },
  { id: 'rest-only-pet', category: '紧凑界面', title: '平时只显示宠物，没有按钮、状态条和输入框，窗口很小', steps: ['fresh:at rest only the pet is shown'],
    method: '宠物出现后不移动鼠标，查看窗口与控件。', expected: '只看到宠物（有话时才有气泡），窗口不超过 240×300。',
    ok: '静止时界面上只有宠物，按钮、状态条、名字行、输入框都不可见；窗口尺寸如括号所示。', useNote: true,
    shots: [['fresh:at rest only the pet is shown', '静止状态：只有宠物，没有任何控件。']] },
  { id: 'hover-controls', category: '紧凑界面', title: '鼠标悬停时出现控件，移开后再次隐藏', steps: ['fresh:hovering the pet reveals the controls'],
    method: '把鼠标移到窗口上，再移出（移出一步由测试触发离开事件）。', expected: '悬停时出现状态条、名字行和按钮，移开后全部隐藏。',
    ok: '悬停后状态条、名字行和五个按钮淡入；移开后又全部消失。移出一步使用的是合成的鼠标离开事件，不是真实的指针移出。',
    shots: [['fresh:hovering the pet reveals the controls', '移开鼠标后的画面（控件已隐藏）。']], extra: [['hover-shown.png', '鼠标悬停时的画面：状态条、名字行、按钮均已显示。']] },
  { id: 'feeding', category: '日常照顾', title: '喂食会降低饥饿并显示食物', steps: ['fresh:feeding lowers hunger', 'live:feeding lowers hunger'],
    method: '把饥饿值设为 80，打开“喂食”并给白饭（假 CLI 与真实 lh 各跑一次）。', expected: '饥饿值下降，食物图案出现，宠物有反应。',
    ok: '喂白饭后饥饿值从 80 降到 45 左右，出现食物图案和反应气泡（假 CLI 与真实 lh 两次都如此）。',
    shots: [['fresh:feeding lowers hunger', '喂食中：嘴边有食物，饥饿条下降，反应气泡。（假 CLI）'], ['live:feeding lowers hunger', '喂食中的画面。（真实 lh）']] },
  { id: 'affection-stage', category: '好感度', title: '好感跨过阈值时关系阶段提升并解锁话题', steps: ['fresh:affection crossing 15', 'live:affection crossing 15'],
    method: '把好感设为 14 并摸一下宠物（假 CLI 与真实 lh 各跑一次）。', expected: '名字行由“陌生 ♥14”变为“熟悉 ♥15”，并发出带解锁话题的阶段提升事件。',
    ok: '名字行里的阶段由“陌生”变为“熟悉”，解锁“聊聊爱好、奇怪的冷知识、脑筋急转弯”。',
    shots: [['fresh:affection crossing 15', '阶段提升后：熟悉 ♥15。（假 CLI）'], ['live:affection crossing 15', '阶段提升后的画面。（真实 lh）']], extra: [['stage-before.png', '提升前一刻：陌生 ♥14 · 距「熟悉」1。']] },
  { id: 'release', category: '生命周期', title: '放生会通过 lh 删除 agent 并回到选蛋界面', steps: ['fresh:release deletes the agent through lh', 'live:release deletes the real agent'],
    method: '打开菜单选“放生并删除 agent”并确认（假 CLI 记录调用；真实 lh 再查 agent 是否已不存在）。', expected: '回到选蛋界面，并且 agent 已被删除。',
    ok: '回到了选蛋界面；假 CLI 记录到 `lh agent delete <id> --yes`；真实运行里对旧 agent id 执行 `lh agent view` 失败，说明真实 agent 已被删除。',
    shots: [['fresh:release deletes the agent through lh', '放生后再次出现的选蛋界面。（假 CLI）'], ['live:release deletes the real agent', '放生后再次出现的选蛋界面。（真实 lh）']], texts: ['release-check.txt', 'release-check-live.txt'] },
  { id: 'pixel-art', category: '像素画', title: '三个像素物种（成年体型）在各种心情下外观各异', steps: ['art:sprite sheet'],
    method: '用应用自己的绘制代码渲染每个物种、每种心情。', expected: '火、水、草三种宠物外观不同，只有成年体型，不同心情脸不同。',
    ok: '总览图共三行（三物种，成年体型）五列（待机、开心、难过、饥饿、睡觉）；物种差异明显，心情改变脸和特效。',
    extra: [['sprite-sheet.png', '总览图：行为 embit/bubbo/sprig（只有成年体型），列为待机、开心、难过、饥饿、睡觉。']] },
  { id: 'dafeiyu-egg', category: '大肥鱼', title: '蛋界面新增第四颗“鲸之蛋”，即大肥鱼', steps: ['dafeiyu:the egg screen offers four eggs'],
    method: '首次启动，点击第四颗蛋。', expected: '共四颗蛋，第四颗为鲸之蛋，介绍里提到大肥鱼，可起名。',
    ok: '界面共四颗蛋，第四颗标注“鲸之蛋”，介绍文字写明是大肥鱼并注明非 DeepSeek 官方，名字框可输入。',
    shots: [['dafeiyu:the egg screen offers four eggs', '选中鲸之蛋：深蓝蛋被高亮，介绍里写着大肥鱼。']] },
  { id: 'dafeiyu-hatch', category: '大肥鱼', title: '孵化大肥鱼时播放“蓝鲸现世”动画', steps: ['dafeiyu:hatching plays the'],
    method: '选鲸之蛋并孵化，观察孵化画面。', expected: '孵化画面里出现大肥鱼的透明动画，窗口没有被挤压。',
    ok: '孵化画面中播放大肥鱼的出场动画，孵化步骤列表保持正常版式。',
    shots: [['dafeiyu:hatching plays the', '孵化画面：大肥鱼出场动画，步骤列表正常。']] },
  { id: 'dafeiyu-pet', category: '大肥鱼', title: '大肥鱼以透明视频出现在小窗口里，平时不显示控件', steps: ['dafeiyu:the pet appears as a transparent video'],
    method: '孵化完成后不移动鼠标，查看窗口和视频。', expected: '视频透明播放（待机动画），窗口不超过 240×300，没有控件。',
    ok: '大肥鱼以透明视频播放待机动画，窗口很小，没有任何控件显示；视频尺寸 640 宽，正在播放。', useNote: true,
    shots: [['dafeiyu:the pet appears as a transparent video', '大肥鱼在小窗口中的待机画面，无控件。']] },
  { id: 'dafeiyu-feed', category: '大肥鱼', title: '悬停后出现控件，喂白饭会播放吃饭动画', steps: ['dafeiyu:hovering shows the controls'],
    method: '把饥饿值设为 80，悬停后点“喂食”选白饭。', expected: '出现控件，动画切换为“吃白饭”。',
    ok: '悬停后控件出现；喂白饭后视频切换到 eat_rice 动画，宠物有反应气泡。',
    shots: [['dafeiyu:hovering shows the controls', '大肥鱼悬停状态：控件已出现，正在吃饭动画中。']] },
  { id: 'dafeiyu-persona', category: '大肥鱼', title: '大肥鱼的人设被写进 agent', steps: ['dafeiyu:the agent was created with the'],
    method: '孵化大肥鱼后检查创建 agent 时传入的 system role 和标题。', expected: 'system role 含“大肥鱼”和“鱼片”，标题为“Mow (Dafeiyu)”。',
    ok: '创建 agent 时 system role 里包含大肥鱼与“鱼片”的称呼，标题为“Mow (Dafeiyu)”。', texts: ['run-log.txt'], noShot: true },
  { id: 'real-agent', category: '创建 agent', title: '使用真实 lh 创建真实 agent，并带有宠物人设', steps: ['live:real lh is logged in', 'live:the LobeHub agent exists'],
    method: '用真实 lh（个人空间 API key）选草之蛋孵化，再对创建出的 agent 执行 `lh agent view`。', expected: '跳过登录，生成 agent id，agent 带有宠物名字和物种人设。',
    ok: '跳过了登录，创建出真实的 agent id，`lh agent view` 显示宠物名字与物种人设。',
    shots: [['live:real lh is logged in', '对接真实 LobeHub CLI 孵化后的宠物界面。']], texts: ['agent-view-excerpt.txt'] },
  { id: 'llm-greeting', category: '性格', title: '宠物用真实模型以角色口吻打招呼', steps: ['live:first greeting comes from the real model'],
    method: '查看孵化后的第一条气泡及其来源标记。', expected: '由 agent 生成的简短中文问候，而不是预设台词。',
    ok: '问候气泡来自真实 agent（来源标记为 llm），简短、符合角色，且是中文。',
    shots: [['live:first greeting comes from the real model', '草系宠物的第一句由模型生成的问候。']], texts: ['chat-transcript.txt'] },
  { id: 'memory', category: '记忆', title: '宠物记得主人说过的话', steps: ['live:chat: the pet answers and remembers'],
    method: '先告诉宠物名字和爱吃的东西，随后问它是否记得名字。', expected: '第二次回复里正确叫出主人的名字（同一个 LobeHub topic）。',
    ok: '隔了一轮再问，宠物答出了此前告诉它的主人名字。',
    shots: [['live:chat: the pet answers and remembers', '聊天框已打开，气泡里宠物回忆起主人的名字和爱吃的食物。']], texts: ['chat-transcript.txt'] },
  { id: 'proactive', category: '主动行为', title: '饿了的宠物会主动开口', steps: ['live:proactive: a hungry pet speaks up'],
    method: '把饥饿值设为 95、清掉说话冷却并触发一次心跳，不输入任何内容。', expected: '宠物用模型生成的话主动要吃的。',
    ok: '没有任何用户输入，宠物用真实 agent 生成的话（来源标记 llm）主动要吃的。',
    shots: [['live:proactive: a hungry pet speaks up', '饥饿条见底，宠物主动提出想吃东西。']], texts: ['chat-transcript.txt'] },
  { id: 'busy-lock', category: '工作状态', title: '宠物思考或干活时只显示宠物和“思考中”，悬停也不出现控件，其他操作被拒绝', steps: ['busy:while the pet works the controls stay hidden'],
    method: '发送一条消息，等宠物开始思考后把鼠标放在宠物上，再尝试喂食。', expected: '状态条、按钮、输入框全部隐藏（悬停也一样），气泡显示动态的“思考中”，喂食等操作被拒绝。',
    ok: '思考期间只剩宠物和“思考中”气泡；鼠标就放在宠物上，控件依然不可见；此时调用喂食被拒绝（原因：忙碌中）。',
    shots: [['busy:while the pet works the controls stay hidden', '思考状态：只有宠物和“思考中”气泡，没有任何控件。']] },
  { id: 'busy-return', category: '工作状态', title: '回复到达后，悬停时控件重新出现', steps: ['busy:when the reply arrives the controls come back'],
    method: '等回复出现后把鼠标移到窗口上。', expected: '回复显示在气泡里，悬停后状态条和按钮恢复。',
    ok: '回复出现后悬停，状态条、名字行和按钮恢复显示。',
    shots: [['busy:when the reply arrives the controls come back', '回复到达后悬停：控件恢复。']] },
  { id: 'escape-stop', category: '工作状态', title: '按 Esc 可以停止正在进行的任务', steps: ['busy:Escape stops a running task'],
    method: '发送一个耗时的任务，思考中按 Esc。', expected: '任务被终止，宠物说一句“不想了”，界面恢复可操作。',
    ok: '按 Esc 后任务被终止，宠物说“好吧，不想了。”，忙碌状态解除。',
    shots: [['busy:Escape stops a running task', '按 Esc 之后：气泡显示“好吧，不想了。”，控件恢复。']] },
  { id: 'long-reply', category: '回复显示', title: '很长的回复在气泡内滚动，不会溢出盖住宠物', steps: ['longreply:a very long reply scrolls'],
    method: '让宠物回复 14 行很长的内容。', expected: '气泡限高、内部可滚动、保留换行，且完全在窗口内。',
    ok: '气泡高度被限制在约 76px，内容在气泡里滚动并保留换行，整个气泡都在窗口内。', useNote: true,
    shots: [['longreply:a very long reply scrolls', '长回复：气泡内出现滚动条，没有盖住宠物和控件。']] },
  { id: 'paste-image', category: '图片', title: '可以粘贴图片，图片被上传并作为上下文发给宠物', steps: ['busy:a pasted picture is attached'],
    method: '用剪贴板粘贴一张图片（Ctrl/⌘+V），输入一句话并发送（假 CLI 记录调用）。', expected: '输入框上方出现缩略图，发送后依次上传文件、创建带图的消息、再运行 agent，缩略图清空。',
    ok: '粘贴后出现缩略图；发送时 CLI 调用顺序为 file upload、message create、message add-files、agent run；发送后缩略图消失。',
    shots: [['busy:a pasted picture is attached', '发送后的画面。']], extra: [['paste-chip.png', '粘贴后：输入框上方出现图片缩略图，可点 × 移除。']] },
  { id: 'local-bind', category: '本机能力', title: '孵化时默认开启“使用这台电脑”，并把 agent 绑定到本机设备', steps: ['busy:the computer-access option was on by default'],
    method: '孵化时保持默认勾选，检查 CLI 调用：没有在线设备时启动 lh connect，并写入 agent 的 agencyConfig。', expected: 'agent 的 agencyConfig 为 { boundDeviceId: <本机设备>, executionTarget: local }。',
    ok: '默认勾选下，应用启动了 lh connect 守护进程并把 agent 绑定到该设备（agencyConfig 含 boundDeviceId 与 executionTarget=local）。这是用假 CLI 验证的流程；真实文件读写没有在这里执行。', texts: ['run-log.txt'], noShot: true },
  { id: 'local-toggle', category: '本机能力', title: '菜单里可以随时关闭或重新开启本机能力', steps: ['busy:turning computer access off'],
    method: '打开菜单，点“本机能力”关闭，再点一次开启（假 CLI 记录调用）。', expected: '关闭时解除绑定（boundDeviceId 置空），开启时重新绑定。',
    ok: '关闭后 agent 的绑定被清空，菜单文字变为“关”；再次开启后重新绑定到本机设备。',
    shots: [['busy:turning computer access off', '切换本机能力后的画面。']] },
  { id: 'lookup-helpful', category: '性格', title: '被要求查资料时，宠物直接帮忙，而不是推给别的助手', steps: ['live:asked to look something up'],
    method: '真实 agent：问“今天纳斯达克指数大概多少，最近涨还是跌”。', expected: '宠物尝试回答或查证，不说“我只会…”“去问别的专家”。',
    ok: '宠物直接回应了这个查资料的请求，没有推脱给别的助手。回复长度见括号。', useNote: true,
    shots: [['live:asked to look something up', '查资料类问题的回复。']], texts: ['chat-transcript.txt'] },
  { id: 'image-recognised', category: '图片', title: '真实模型能识别粘贴的图片内容', steps: ['live:a pasted picture is recognised'],
    method: '真实 agent：粘贴应用图标（三颗蛋），问“这张图里有几个蛋？分别什么颜色？”', expected: '回答里提到三颗蛋及其颜色。',
    ok: '宠物看图后答出了蛋的数量与颜色，说明图片确实送达了模型。',
    shots: [['live:a pasted picture is recognised', '看图回答的画面。']], texts: ['chat-transcript.txt'] },
  { id: 'drop-paths', category: '文件', title: '把任意文件拖给宠物，只把路径交给它，不上传文件', steps: ['busy:dropping files hands their paths'],
    method: '把两个真实文件拖进窗口，输入一句话发送（假 CLI 记录调用）。', expected: '输入框上方出现带文件名的标签；发送时没有 file upload 调用，提示里带有两个文件的绝对路径，并启用本机工具。',
    ok: '拖入后出现两个带文件名的标签；发送时没有上传任何文件，agent 收到的提示里包含两个文件的绝对路径，并带上了本机工具。拖入使用的是带真实路径的文件对象，不是在 Finder 里真实拖拽。',
    shots: [['busy:dropping files hands their paths', '发送后的画面。']], extra: [['drop-chips.png', '拖入两个文件后：输入框上方是带文件名的标签，可点 × 移除。']] },
  { id: 'drop-enable', category: '文件', title: '本机能力关闭时拖入文件，会先询问是否开启，再继续', steps: ['busy:dropping a file while computer access is off'],
    method: '先关闭本机能力，再拖入文件并发送。', expected: '弹出询问，确认后重新绑定设备并带着路径继续发送。',
    ok: '关闭状态下拖入文件并发送，应用先询问是否开启本机能力；确认后重新绑定到本机设备，并把路径交给了宠物。',
    shots: [['busy:dropping a file while computer access is off', '确认开启后继续发送的画面。']] },
  { id: 'daemon-claim', category: '本机能力', title: '认领宠物时启动 lh connect --daemon', steps: ['daemon:claiming a pet starts lh connect --daemon'],
    method: '孵化时保持“使用这台电脑”勾选，检查 CLI 调用。', expected: '先查询守护进程状态，没在运行就执行 lh connect --daemon。',
    ok: '孵化过程中应用启动了 lh connect 守护进程（假 CLI 记录到一次启动）。真实的守护进程没有在这里运行。', texts: ['run-log.txt'], noShot: true },
  { id: 'daemon-relaunch', category: '本机能力', title: '每次启动应用都会确保守护进程在运行，已在运行时不重复启动', steps: ['daemon:relaunching the app starts the daemon again', 'daemon:relaunching while the daemon is already running'],
    method: '把守护进程“弄丢”后重启应用；再在守护进程正常时重启一次。', expected: '前者重新启动守护进程，后者不会启动第二个。',
    ok: '守护进程消失后重启应用，它被重新启动；守护进程已在运行时再重启应用，没有启动第二个（真实 CLI 对重复启动会报错退出，应用已把“已在运行”当作成功处理）。', texts: ['run-log.txt'], noShot: true },
  { id: 'stop-button', category: '工作状态', title: '宠物思考时，鼠标悬停只出现一个“停止”按钮，点击即可打断', steps: ['busy:hovering while the pet works shows only a Stop button'],
    method: '发送一个耗时的任务，思考中把鼠标放到宠物上，再点“停止”。', expected: '悬停时只出现“停止”按钮，状态条和其他按钮仍隐藏；鼠标移开按钮消失；点击后任务被打断，宠物说“不想了”。',
    ok: '思考时悬停只出现红色的“停止”按钮，状态条、名字行和其他按钮仍然隐藏；鼠标移开按钮消失，移回又出现；点击后任务被终止，宠物说“好吧，不想了。”，界面恢复。移开一步用的是合成的鼠标离开事件。',
    shots: [['busy:hovering while the pet works shows only a Stop button', '点击“停止”之后的画面。']], extra: [['stop-visible.png', '思考中悬停：只有宠物、“思考中”气泡和红色的“停止”按钮。']] },
  { id: 'old-lh', category: '本机能力', title: '旧版 lh 写不进设备绑定时，宠物仍能访问这台电脑，并提示升级 lh', steps: ['oldlh:an lh that cannot write the binding'],
    method: '用一个不认 --agency-config-file 的假 lh（模拟旧版）孵化，随后发一条消息。', expected: '气泡提示升级 lh；之后每次运行都用 --device 指定设备，并带上本机工具。',
    ok: '绑定失败后宠物没有放弃：气泡提示“升级 lh”，并且后续运行直接指定了设备并带上本机工具。这是用假 lh 模拟旧版，真实旧版 lh 上没有验证。',
    shots: [['oldlh:an lh that cannot write the binding', '旧版 lh 场景的画面。']] },
  { id: 'hover-strict', category: '紧凑界面', title: '只要鼠标不在宠物上，所有控件都不显示，即使聊天框是打开的', steps: ['busy:with the chat box open, moving the pointer away hides everything'],
    method: '打开聊天框并输入草稿，然后让鼠标离开窗口，再移回来。', expected: '移开后状态条、按钮、聊天框全部隐藏，输入框不再占着键盘焦点；移回来草稿还在。',
    ok: '聊天框打开着、输入框有焦点时，鼠标一移开，所有控件立刻隐藏，输入框失去键盘焦点；鼠标移回后草稿原样还在。移开一步用的是合成的鼠标离开事件，不是真实的指针移出。',
    shots: [['busy:with the chat box open, moving the pointer away hides everything', '鼠标移回后：草稿还在，控件重新出现。']], extra: [['away-hidden.png', '聊天框打开时鼠标移开：只剩宠物，没有任何控件。']] },
];

const plan = [];
const cases = [];
for (const c of CHECKS) {
  const hasShot = !c.noShot;
  plan.push({ id: c.id, title: c.title, category: c.category, verifier: 'agent', method: c.method, expected: c.expected, requiredEvidence: [...(hasShot ? ['screenshot'] : []), ...(c.texts ? ['text'] : [])] });
  const recs = c.steps.map(find);
  const ran = recs.filter(Boolean);
  let status = 'pass';
  let observation = c.ok;
  if (ran.length < c.steps.length) {
    status = 'blocked';
    observation = `本轮没有执行这项检查（缺少步骤：${c.steps.filter((_, i) => !recs[i]).join('、')}），不声称通过。`;
  } else if (ran.some((r) => r.status === 'fail')) {
    status = 'fail';
    const bad = ran.find((r) => r.status === 'fail');
    observation = `未通过：${bad.name}。${bad.note}`;
  } else if (c.useNote && ran[0].note) {
    observation = `${c.ok}（${ran[0].note}）`;
  }
  const evidence = [];
  for (const [spec, d] of c.shots || []) { const r = find(spec); const e = r && r.shot && copy(r.shot, d); if (e) evidence.push(e); }
  for (const [f, d] of c.extra || []) { const e = copy(f, d); if (e) evidence.push(e); }
  for (const t of c.texts || []) { const e = copy(t, TEXTS[t]); if (e) evidence.push(e); }
  cases.push({ id: c.id, name: c.title, category: c.category, surface: 'desktop', status, observation, evidence });
}

const passed = cases.filter((x) => x.status === 'pass').length;
const failed = cases.filter((x) => x.status === 'fail').length;
const blocked = cases.filter((x) => x.status === 'blocked').length;
const result = {
  title: 'Pixel Pet 桌宠 v0.2：思考锁定、长回复滚动、粘贴图片、本机能力、灵活提示词',
  scenario: 'coding',
  surface: 'desktop',
  entry: 'xvfb-run -a node e2e/run.js all',
  createdAt: new Date().toISOString(),
  plan,
  cases,
  summary: { total: cases.length, passed, failed, blocked, verdict: failed ? 'fail' : blocked ? 'partial' : 'pass', conclusion: `共 ${cases.length} 项检查：${passed} 项通过，${failed} 项未通过，${blocked} 项未执行。` },
};
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(dir, 'proposal.md'), fs.readFileSync(path.join(__dirname, 'acceptance-proposal.md'), 'utf8'));
fs.writeFileSync(path.join(dir, 'report.md'), fs.readFileSync(path.join(__dirname, 'acceptance-report-tail.md'), 'utf8'));
console.log(dir);
