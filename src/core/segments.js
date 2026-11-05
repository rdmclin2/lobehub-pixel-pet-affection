'use strict';
// 分段式表达 (docs/segmented-reply.md): one reply said as several short messages, one after another, the way a
// person texts — an emoji first, then 「在吗？」「有点想你了。」「在干什么？」. The persona asks the agent to put
// each message on its own line (persona.js SEGMENT_RULE); this file turns the reply (final, or the text streamed
// so far) into the ordered messages and decides how long she "types" before each one. The pet window shows them
// one by one (renderer/app.js, createPlayer below); 聊天记录, reading aloud, memes and the guard still use the
// whole reply once.
//
//   split(text, opts)            → ['😝', '在吗？', '有点想你了。', '在干什么？']   final reply → messages
//   plan(text, { final })        → { segments, complete }   streamed text: the last line may still be written
//   typingMs(seg, i, opts, rnd)  → ms of 「对方正在输入…」 before message i appears
//   createPlayer(hooks, opts)    → feeds plans in, reveals one message at a time with timers it owns
//
// Pure and DOM-free: the renderer loads it as a <script> (window.PetSegments), main and the tests require() it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetSegments = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULTS = Object.freeze({ max: 6, maxLen: 36, charMs: 80 });
  const RANGE = Object.freeze({ max: [2, 8], charMs: [30, 200] });
  // a reply longer than this (all of it) or with a code block is an answer to read, not a chat: kept whole
  const MAX_TOTAL = 400;

  // one emoji "character": a pictograph with its modifiers / ZWJ joins / variation selector, or a flag pair
  const EMOJI = '(?:\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*|\\p{Regional_Indicator}{2})';
  const EMOJI_ONLY_RE = new RegExp(`^(?:${EMOJI}|\\s)+$`, 'u');
  const LEAD_EMOJI_RE = new RegExp(`^((?:${EMOJI}\\s*)+)(?=\\S)`, 'u');
  // sentence ends: CJK and ASCII terminators (runs of them, with closing quotes / brackets after)
  const SENTENCE_RE = /[^。！？!?～~…]+(?:[。！？!?～~…]+|$)[」』”’）)】]*/gu;
  const LIST_RE = /^\s*(?:[-*•]\s|\d+[.)、]\s?|#{1,6}\s|\|)/;

  const chars = (s) => [...String(s || '')].length;
  const isEmojiOnly = (s) => !!s && EMOJI_ONLY_RE.test(s);
  const clampInt = (v, [min, max], d) => (Number.isFinite(v) ? Math.round(Math.max(min, Math.min(max, v))) : d);

  function options(o = {}) {
    return {
      max: clampInt(o.max, RANGE.max, DEFAULTS.max),
      maxLen: Number.isFinite(o.maxLen) && o.maxLen >= 8 ? Math.round(o.maxLen) : DEFAULTS.maxLen,
      charMs: clampInt(o.charMs, RANGE.charMs, DEFAULTS.charMs),
    };
  }

  // Whether a reply should be kept as one message whatever its lines: code, Markdown lists / tables, long answers.
  function keepWhole(text) {
    if (/```/.test(text) || chars(text) > MAX_TOTAL) return true;
    const lines = text.split('\n').filter((l) => l.trim());
    return lines.filter((l) => LIST_RE.test(l)).length >= 2;
  }

  // 「😝 在吗？」 → ['😝', '在吗？']; an emoji at the end stays with its words.
  function splitLeadEmoji(line) {
    const m = LEAD_EMOJI_RE.exec(line);
    if (!m) return [line];
    return [m[1].trim(), line.slice(m[1].length).trim()].filter(Boolean);
  }

  // A line longer than maxLen as sentences packed up to maxLen each; a sentence longer than that stays whole
  // (cutting a sentence in the middle reads worse than a long message).
  function splitLong(line, maxLen) {
    if (chars(line) <= maxLen) return [line];
    const parts = (line.match(SENTENCE_RE) || [line]).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const s of parts) {
      const last = out[out.length - 1];
      if (last !== undefined && chars(last) + chars(s) <= maxLen && !isEmojiOnly(last)) out[out.length - 1] = last + s;
      else out.push(s);
    }
    return out;
  }

  // Two messages folded into one (over the cap): no space between CJK, a space between Latin words.
  function join(a, b) {
    return /[　-鿿＀-￯]$/u.test(a) || /^[　-鿿＀-￯]/u.test(b) || isEmojiOnly(a) ? `${a}${b}` : `${a} ${b}`;
  }
  function cap(segs, max) {
    if (segs.length <= max) return segs;
    return [...segs.slice(0, max - 1), segs.slice(max - 1).reduce(join)];
  }

  // The final reply as messages, in order. One short line → one message (never split). Lines are the protocol;
  // a leading emoji is its own message; a long line is cut at sentence ends; more than `max` → the rest folds
  // into the last one.
  function split(text, opts = {}) {
    const o = options(opts);
    const t = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!t) return [];
    if (keepWhole(t)) return [t];
    const segs = [];
    for (const raw of t.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      for (const piece of splitLeadEmoji(line)) segs.push(...(isEmojiOnly(piece) ? [piece] : splitLong(piece, o.maxLen)));
    }
    return cap(segs, o.max);
  }

  // Text streamed so far → { segments, complete }: `complete` messages are final (their line has ended), the
  // one after them (if any) is still being written. Lines that ended are split like the final reply; the open
  // last line only loses its leading emoji (cutting it at sentences would move as it grows). Everything up to
  // `complete` stays the same as more text arrives, so what was shown never changes under the reader.
  function plan(text, { final = false, ...opts } = {}) {
    if (final) {
      const segments = split(text, opts);
      return { segments, complete: segments.length };
    }
    const o = options(opts);
    const t = String(text || '').replace(/\r\n?/g, '\n').replace(/^\s+/, '');
    if (!t) return { segments: [], complete: 0 };
    if (/```/.test(t) || chars(t) > MAX_TOTAL) return { segments: [t.trim()], complete: 0 };
    const nl = t.lastIndexOf('\n');
    const done = nl < 0 ? [] : split(t.slice(0, nl), o);
    const open = nl < 0 ? t : t.slice(nl + 1);
    const tail = open.trim() ? splitLeadEmoji(open.trim()) : [];
    // a tail that is only an emoji may still grow into 「😝 在吗」: keep it open
    const all = [...done, ...tail];
    let complete = done.length + Math.max(0, tail.length - 1);
    if (all.length > o.max) { // the cap folds into message max-1, which then stays open until the end
      complete = Math.min(complete, o.max - 1);
      return { segments: cap(all, o.max), complete };
    }
    return { segments: all, complete };
  }

  // How long she types before message i. The first one comes at once (she has been 思考中… already); an emoji
  // is quick; words take `charMs` a character, between 0.5 and 2.4 s, ±20 % so the rhythm is not mechanical.
  function typingMs(seg, i, opts = {}, rnd = Math.random) {
    if (i === 0) return 0;
    const o = options(opts);
    const jitter = 0.8 + 0.4 * rnd();
    if (isEmojiOnly(seg)) return Math.round(420 * jitter);
    const base = Math.max(500, Math.min(2400, 320 + chars(seg) * o.charMs));
    return Math.round(base * jitter);
  }

  // The schedule for showing one reply: give it plans (feed) as the text streams and once more with the final
  // text; it reveals one message at a time. Hooks (all optional):
  //   typing(i)          she starts typing message i (show 「…」; it goes when reveal(i) comes)
  //   reveal(i, text)    message i appears
  //   live(i, text)      the first message is still being written (streamed): show it as it is, with a caret
  //   update(i, text)    message i (already shown) changed: the final text corrected it (tool preamble, cap)
  //   truncate(n)        only the first n messages stay
  //   done(segments)     the last message of the final reply is on screen
  //   log(event)         every step, for the e2e runs
  // The player owns exactly one timer at a time; cancel() clears it (a new message from the owner, another
  // line taking the bubble), so nothing fires after it.
  function createPlayer(hooks = {}, opts = {}) {
    const h = hooks;
    const call = (k, ...a) => { try { if (h[k]) h[k](...a); } catch { /* a hook never breaks the schedule */ } };
    const setT = h.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = h.clearTimeout || ((t) => clearTimeout(t));
    const rnd = h.random || Math.random;
    const now = h.now || (() => Date.now());
    let o = options(opts);
    let st = null; // { id, segments, complete, final, shown, live, timer, typing, done }

    const log = (ev, extra = {}) => call('log', { ev, id: st ? st.id : null, ...extra });
    function stopTimer() {
      if (st && st.timer !== null) { clearT(st.timer); st.timer = null; }
    }
    const reveal = (i, extra = {}) => {
      st.typing = -1;
      st.shown++;
      call('reveal', i, st.segments[i]);
      log('reveal', { i, text: st.segments[i], ...extra });
    };
    const startTyping = (i) => {
      if (st.typing === i) return;
      st.typing = i;
      st.typingAt = now();
      call('typing', i);
      log('typing', { i });
    };
    function pump() {
      if (!st || st.timer !== null || st.done) return;
      const i = st.shown;
      if (i < st.complete) {
        if (st.live === i) { // it was on screen while written: now it is final, no typing again
          st.live = -1;
          reveal(i, { wasLive: true });
          return pump();
        }
        // she has been typing it since its line opened (streamed): that time counts
        const ms = typingMs(st.segments[i], i, o, rnd);
        const wait = Math.max(0, st.typing === i ? ms - (now() - st.typingAt) : ms);
        if (wait <= 0) { // the first one, or typed long enough already: at once
          reveal(i, { ms });
          return pump();
        }
        startTyping(i);
        st.timer = setT(() => {
          st.timer = null;
          reveal(i, { ms });
          pump();
        }, wait);
        return;
      }
      if (!st.final && i < st.segments.length) {
        // the open line: the first one shows as it streams (with a caret); a later one is 「正在输入」 until it ends
        if (i === 0) { st.live = 0; call('live', 0, st.segments[0]); } else startTyping(i);
        return;
      }
      if (st.final && i >= st.segments.length) {
        st.done = true;
        st.typing = -1;
        log('done', { n: st.segments.length });
        call('done', st.segments.slice());
      }
    }
    return {
      setOptions(next) { o = options(next); },
      // The newest plan for reply `id` (a new id starts over).
      feed(id, p, final = false) {
        if (!st || st.id !== id) {
          stopTimer();
          st = { id, segments: [], complete: 0, final: false, shown: 0, live: -1, timer: null, typing: -1, typingAt: 0, done: false };
          log('start');
        }
        if (st.done && final) return; // the same final text again
        const segs = p.segments.slice();
        // what is already on screen and differs now (the final text corrected it): fix it in place
        const keep = Math.min(st.shown + (st.live >= 0 ? 1 : 0), segs.length);
        for (let i = 0; i < keep; i++) {
          if (segs[i] === st.segments[i]) continue;
          if (i === st.live) continue; // the open line: pump() shows it again (live) or as a message (reveal)
          call('update', i, segs[i]);
          log('update', { i, text: segs[i] });
        }
        const onScreen = st.shown + (st.live >= 0 ? 1 : 0);
        if (segs.length < onScreen) {
          call('truncate', segs.length);
          log('truncate', { n: segs.length });
          st.shown = Math.min(st.shown, segs.length);
          if (st.live >= segs.length) st.live = -1;
        }
        Object.assign(st, { segments: segs, complete: final ? segs.length : p.complete, final: !!final });
        pump();
      },
      // Stop showing it (Esc, a new message, another line in the bubble): no timer is left behind.
      cancel(reason = 'canceled') {
        if (!st) return null;
        stopTimer();
        const r = { id: st.id, shown: st.shown, total: st.segments.length, dropped: st.done ? 0 : Math.max(0, st.segments.length - st.shown), reason };
        if (!st.done) log('cancel', r);
        st = null;
        return r;
      },
      active: () => !!(st && !st.done),
      id: () => (st ? st.id : null),
      state: () => (st ? { id: st.id, total: st.segments.length, complete: st.complete, shown: st.shown, live: st.live, typing: st.typing, final: st.final, done: st.done, timer: st.timer !== null } : null),
    };
  }

  return { DEFAULTS, RANGE, MAX_TOTAL, options, split, plan, typingMs, isEmojiOnly, keepWhole, createPlayer };
});
