'use strict';
// The reply being written in 设置窗口 → 聊天 (PetService#chatAs → `admin-chat-delta` → pages/Chat.tsx), sent as
// increments (T-2818). main keeps what it last showed and sends only what was added: `{ at, append }`, `at` being
// the length the page must already have. Anything that is not a plain append (the first piece of a turn, a meme
// tag or a 「思考」 line taken back out, a restart) goes as the whole text `{ text }`. The page puts it together;
// a piece that does not fit (the page opened mid-reply, a lost delta) asks main for the whole text so far
// (`resync`), never shows a gap or a doubled line.
// The page also merges the deltas of one frame (requestAnimationFrame) into one render: `merge` folds a queue.
// Pure and Electron-free: required by main and the tests, bundled into the settings window by Vite.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetChatLive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // main: what to send for `next`, given `prev` was the last text sent this turn ('' before the first).
  function encode(prev, next) {
    const p = prev || '';
    if (p && next.length > p.length && next.startsWith(p)) return { at: p.length, append: next.slice(p.length) };
    return { text: next };
  }

  // The page: `live` ({ speciesId, turnId, text } or null) after delta `d`. Returns { live, resync }: when
  // resync is true the delta did not fit and `live` is unchanged (keep showing what is there, ask main).
  function apply(live, d) {
    if (typeof d.append !== 'string') return { live: { speciesId: d.speciesId, turnId: d.turnId, text: d.text || '' }, resync: false };
    const same = live && live.speciesId === d.speciesId && (live.turnId === d.turnId || live.turnId === null);
    if (same && live.text.length === d.at) return { live: { speciesId: d.speciesId, turnId: d.turnId, text: live.text + d.append }, resync: false };
    return { live, resync: true };
  }

  // The page: the deltas that came in during one frame, folded in order into one state change.
  function merge(live, queue) {
    let cur = live;
    let resync = false;
    for (const d of queue) {
      const r = apply(cur, d);
      cur = r.live;
      // a whole-text delta later in the frame repairs an earlier gap
      resync = r.resync || (resync && typeof d.append === 'string');
    }
    return { live: cur, resync };
  }

  return { encode, apply, merge };
});
