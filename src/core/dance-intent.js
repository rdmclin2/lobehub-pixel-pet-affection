'use strict';
// 聊天里说「跳个舞」(docs/vrm-dance.md §6.2 / §9.2): recognise a dance request or a stop in what the owner
// typed — locally, with rules, never with the model (the LobeHub Responses path has no tool calls, so the
// model cannot start a dance reliably; a rule is free and predictable). The message still goes to her agent.
// Pure; UMD (window.PetDanceIntent in the renderer, require() in the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetDanceIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // a stop: 别跳了 / 不要跳了 / 停下 / 停一下 / 不跳了 / 停止跳舞 / 别再跳了
  const STOP_RE = /(别|不要|不用|甭|不)再?跳(了|舞了|啦)|(停下|停一下|停止跳舞|停下来|别跳舞|不要跳舞)/;
  // a negated request is not a request: 不想跳舞 / 我不会跳舞 / 别跳舞
  const NEG_RE = /(不想|不会|不能|不要|别|不用|没)[^，。！？,.!?]{0,3}跳/;
  // a request: 跳(个/支/段/一段/一下/一曲)舞 / 来(段/支/一段)舞 / 跳舞 / 跳《name》 / 跳一下<name>
  const ASK_RE = /跳(个|支|段|一段|一支|一个|一下|一曲|只)?舞|来(段|支|一段|一支|个|一曲)舞|跳舞|跳一下|跳一段|跳《/;
  // words with 跳 / 舞 that are not about dancing
  const NOT_RE = /跳过|跳转|跳槽|跳楼|心跳|跳闸|跳线|跳页|舞台|舞弊|鼓舞|飞舞|舞蹈课|舞蹈老师/;

  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-·・「」『』《》"'“”]/g, '');

  // the dance a message names: the longest dance name (or id) contained in it, at least 2 characters
  function namedDance(text, dances) {
    const t = norm(text);
    let best = null;
    for (const d of dances || []) {
      // the whole name, its words (「自制小舞 Homemade」 → 自制小舞, homemade) and the id without its hash suffix
      const keys = [d.name, d.id, ...String(d.name || '').split(/\s+/), String(d.id || '').replace(/-[0-9a-f]{4}$/, '')];
      for (const key of keys) {
        const k = norm(key);
        if (k.length >= 2 && t.includes(k) && (!best || k.length > best.len)) best = { id: d.id, len: k.length };
      }
    }
    return best ? best.id : null;
  }

  // → { action: 'stop' } | { action: 'start', id: <named dance id or null for any> } | null
  function matchDanceIntent(text, dances = [], { dancing = false } = {}) {
    const s = String(text || '').trim();
    if (!s || s.length > 60) return null; // a long message is a conversation, not a command
    if (STOP_RE.test(s)) return dancing ? { action: 'stop' } : null;
    if (NOT_RE.test(s) && !/跳(个|支|段|一段)?舞/.test(s.replace(NOT_RE, ''))) return null;
    if (NEG_RE.test(s)) return null;
    if (!ASK_RE.test(s)) return null;
    const id = namedDance(s, dances);
    // 跳一下 / 跳《 alone only counts with a dance name: 「跳一下试试」 is not a dance request
    if (!id && !/跳(个|支|段|一段|一支|一个|一下|一曲|只)?舞|来(段|支|一段|一支|个|一曲)舞/.test(s)) return null;
    return { action: 'start', id };
  }

  // any dance but the one danced last (when there is a choice)
  function pickOther(dances, recent = []) {
    const list = (dances || []).filter((d) => d && d.id);
    if (!list.length) return null;
    const rest = list.filter((d) => d.id !== recent[0]);
    const from = rest.length ? rest : list;
    return from[Math.floor(Math.random() * from.length)];
  }

  return { matchDanceIntent, namedDance, pickOther };
});
