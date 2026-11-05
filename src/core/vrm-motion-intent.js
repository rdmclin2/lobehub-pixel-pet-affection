'use strict';
// 聊天里说「点个头」「鞠个躬」「伸个懒腰」「坐下」(T-5084): a request for one of the motion library's clips, or to stop
// it, recognised locally with rules like core/dance-intent.js (never by the model: the LobeHub Responses path has
// no tool calls). The message still goes to her agent. → { action: 'play', group, label } | { action: 'stop' } | null.
// The groups are the motion index's (src/core/vrm-motion-index.json, docs/vrm-motion-library.md §2); the director
// plays one of the group's clips for her style (director.play({ group })). Dancing stays with dance-intent.js: 跳舞
// / 跳一下 / 跳个舞 are not matched here. Pure; UMD (window.PetMotionIntent / require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetMotionIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // [regexp, group, label]: the first that matches wins (a longer phrase before a shorter one)
  const ASKS = [
    [/点(个|一下|点)?头/, 'nod', '点头'],
    [/摇(个|一下|摇)?头/, 'shake', '摇头'],
    [/鞠(个|一个)?躬|行(个)?礼/, 'bow', '鞠躬'],
    [/挥(个|挥|一下)?手|招(个|招)?手|打(个)?招呼|say ?hi/i, 'greet', '挥手'],
    [/拍(个|拍)?手|鼓(个)?掌/, 'clap', '拍手'],
    [/伸(个|一个)?懒腰/, 'stretch', '伸懒腰'],
    [/打(个|一个)?哈欠/, 'yawn', '打哈欠'],
    [/蹦(一下|一个|起来|个)|跳起来/, 'jump', '蹦一下'],
    [/(想一想|想想看|思考一下|琢磨一下)/, 'think', '思考'],
    [/指(一下|给我看|一指)/, 'point', '指一指'],
    [/转(个|一)圈|转过身/, 'turn', '转身'],
    [/(坐下|坐一会|坐着吧|坐会儿)/, 'sit', '坐下'],
    [/(蹲下|蹲一会|蹲着)/, 'crouch', '蹲下'],
    [/(躺下|躺一会|躺着吧|躺会儿)/, 'lay', '躺下'],
    [/(开心一下|笑一个|高兴一下)/, 'happy', '开心'],
    [/(害羞一下|害个羞)/, 'shy', '害羞'],
  ];
  // back to the idle: 站起来 / 站好 / 别做了 / 别动了 / 恢复 / 停止动作
  const STOP_RE = /站起来|站好|别做了|不要做了|别动了|恢复原样|停止动作|别摆了/;
  // a negated request is not a request: 不要点头 / 别鞠躬 / 不想坐下 / 我不会挥手
  const NEG_RE = /(不想|不会|不能|不要|别|不用|没|甭)[^，。！？,.!?]{0,2}$/;
  const DANCE_RE = /跳(个|支|段|一段|一支|一个|一下|一曲|只)?舞|跳舞|跳一下|跳一段/;

  function matchMotionIntent(text, { playing = false } = {}) {
    const s = String(text || '').trim();
    if (!s || s.length > 30) return null; // a long message is a conversation, not a command
    if (STOP_RE.test(s)) return playing ? { action: 'stop' } : null;
    if (DANCE_RE.test(s)) return null; // dance-intent.js has it
    for (const [re, group, label] of ASKS) {
      const m = re.exec(s);
      if (!m) continue;
      if (NEG_RE.test(s.slice(0, m.index))) return null;
      return { action: 'play', group, label };
    }
    return null;
  }

  return { ASKS, matchMotionIntent };
});
