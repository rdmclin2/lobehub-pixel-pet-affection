'use strict';
// 分段式表达 (core/segments.js, docs/segmented-reply.md): splitting a reply into messages, the typing pace,
// and the player that shows them one at a time (fake timers: order, gaps, no timer left after cancel).
const test = require('node:test');
const assert = require('node:assert/strict');
const Seg = require('../src/core/segments');
const settings = require('../src/core/settings');
const persona = require('../src/core/persona');

test('split: one message per line, in order; blank lines dropped', () => {
  assert.deepEqual(Seg.split('😝\n在吗？\n\n有点想你了。\n在干什么？'), ['😝', '在吗？', '有点想你了。', '在干什么？']);
  assert.deepEqual(Seg.split('  第一条\r\n第二条  \r\n\r\n第三条\n'), ['第一条', '第二条', '第三条']);
});

test('split: a kaomoji on its own line is its own message (4 messages, original order)', () => {
  assert.deepEqual(Seg.split('(≧▽≦)\n在吗？\n有点想你了。\n在干什么？'), ['(≧▽≦)', '在吗？', '有点想你了。', '在干什么？']);
});

test('split: one line stays one message however long it is; empty is no message', () => {
  assert.deepEqual(Seg.split('好呀，我给你讲讲今天的天气：早上有点凉，中午出太阳～'), ['好呀，我给你讲讲今天的天气：早上有点凉，中午出太阳～']);
  const long = '今天的天气真的很不错，早上有点凉，记得多穿一点。中午出太阳了，可以出去走走晒晒太阳。晚上又会降温，记得加件外套哦～';
  assert.deepEqual(Seg.split(long), [long]);
  assert.deepEqual(Seg.split(`第一条\n${long}`), ['第一条', long]);
  assert.deepEqual(Seg.split('嗯嗯'), ['嗯嗯']);
  assert.deepEqual(Seg.split(''), []);
  assert.deepEqual(Seg.split('   \n \n'), []);
  assert.deepEqual(Seg.split(null), []);
});

test('split: an emoji stays where she put it: alone on a line it is a message at any position, in a line it stays', () => {
  assert.deepEqual(Seg.split('🥺 在吗？'), ['🥺 在吗？']);
  assert.deepEqual(Seg.split('👨‍👩‍👧 一家人'), ['👨‍👩‍👧 一家人']);
  assert.deepEqual(Seg.split('好开心😊'), ['好开心😊']);
  assert.deepEqual(Seg.split('🥺\n在吗？'), ['🥺', '在吗？']);
  assert.deepEqual(Seg.split('哈哈哈\n🤭\n被你发现了'), ['哈哈哈', '🤭', '被你发现了']);
  assert.deepEqual(Seg.split('就这样\n😝'), ['就这样', '😝']);
  assert.equal(Seg.isEmojiOnly('🥺'), true);
  assert.equal(Seg.isEmojiOnly('👍🏻'), true); // skin tone
  assert.equal(Seg.isEmojiOnly('🥺 🤭'), true);
  assert.equal(Seg.isEmojiOnly('（小声）'), false);
});

test('plan: a streamed line keeps its emoji, and a reply of one line never becomes several messages', () => {
  assert.deepEqual(Seg.plan('🥺 在'), { segments: ['🥺 在'], complete: 0 });
  assert.deepEqual(Seg.plan('🥺 在吗？', { final: true }).segments, ['🥺 在吗？']);
  assert.deepEqual(Seg.plan('今天天气不错。晚上要降温。'), { segments: ['今天天气不错。晚上要降温。'], complete: 0 });
});

test('split: more than `max` messages — the rest folds into the last one', () => {
  assert.deepEqual(Seg.split('一\n二\n三\n四\n五\n六\n七', { max: 4 }), ['一', '二', '三', '四五六七']);
  assert.deepEqual(Seg.split('a\nb\nc\nd', { max: 3 }), ['a', 'b', 'c d']);
  assert.equal(Seg.split('1\n2\n3\n4\n5\n6\n7\n8\n9\n10').length, Seg.DEFAULTS.max);
  // the option is clamped to its range
  assert.equal(Seg.options({ max: 99 }).max, 8);
  assert.equal(Seg.options({ max: 1 }).max, 2);
  assert.equal(Seg.options({ max: 'x' }).max, Seg.DEFAULTS.max);
});

test('split: code, Markdown lists and long answers are kept whole', () => {
  const code = '给你：\n```js\nconsole.log(1)\n```';
  assert.deepEqual(Seg.split(code), [code]);
  const list = '三个要点：\n- 早睡\n- 多喝水\n- 少熬夜';
  assert.deepEqual(Seg.split(list), [list]);
  const huge = Array.from({ length: 40 }, (_, i) => `第${i + 1}行内容比较长一点`).join('\n');
  assert.ok([...huge].length > Seg.MAX_TOTAL);
  assert.deepEqual(Seg.split(huge), [huge]);
});

test('plan: streamed text — ended lines are complete, the open line is not; prefix-stable as it grows', () => {
  assert.deepEqual(Seg.plan('😝\n在吗？\n有点想'), { segments: ['😝', '在吗？', '有点想'], complete: 2 });
  assert.deepEqual(Seg.plan('😝'), { segments: ['😝'], complete: 0 }); // may still grow into 「😝 在吗」
  assert.deepEqual(Seg.plan('😝\n'), { segments: ['😝'], complete: 1 });
  assert.deepEqual(Seg.plan(''), { segments: [], complete: 0 });
  assert.deepEqual(Seg.plan('a\nb', { final: true }), { segments: ['a', 'b'], complete: 2 });
  // growing the text never changes a message that was complete
  const full = '🥺\n在吗？\n有点想你了。\n在干什么呀？';
  let prev = { segments: [], complete: 0 };
  for (let n = 1; n <= [...full].length; n++) {
    const p = Seg.plan([...full].slice(0, n).join(''));
    for (let i = 0; i < prev.complete; i++) assert.equal(p.segments[i], prev.segments[i], `cut at ${n}: message ${i} changed`);
    assert.ok(p.complete >= prev.complete);
    prev = p;
  }
  assert.deepEqual(Seg.plan(full, { final: true }).segments, ['🥺', '在吗？', '有点想你了。', '在干什么呀？']);
  // over the cap: the folded message stays open until the end
  assert.deepEqual(Seg.plan('一\n二\n三\n四\n五', { max: 3 }), { segments: ['一', '二', '三四五'], complete: 2 });
});

test('typingMs: first at once, emoji quick, words by length in 0.5–2.4 s, ±20 % jitter', () => {
  const mid = () => 0.5;
  assert.equal(Seg.typingMs('在吗？', 0, {}, mid), 0);
  assert.equal(Seg.typingMs('🥺', 1, {}, mid), 420);
  assert.equal(Seg.typingMs('在吗？', 1, {}, mid), 560); // 320 + 3 × 80
  assert.equal(Seg.typingMs('有点想你了。', 1, {}, mid), 800);
  assert.equal(Seg.typingMs('一'.repeat(100), 1, {}, mid), 2400);
  assert.equal(Seg.typingMs('好', 1, {}, mid), 500);
  assert.equal(Seg.typingMs('有点想你了。', 1, {}, () => 0), 640);
  assert.equal(Seg.typingMs('有点想你了。', 1, {}, () => 1), 960);
  assert.ok(Seg.typingMs('有点想你了。', 1, { charMs: 200 }, mid) > Seg.typingMs('有点想你了。', 1, { charMs: 30 }, mid));
});

// fake clock for the player
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    now: () => now,
    // run timers in order until `ms` from now
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}
function harness(opts = {}) {
  const c = clock();
  const ev = [];
  const p = Seg.createPlayer({
    setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, random: () => 0.5, now: c.now,
    typing: (i) => ev.push(['typing', i, c.now()]),
    reveal: (i, t) => ev.push(['reveal', i, t, c.now()]),
    live: (i, t) => ev.push(['live', i, t]),
    update: (i, t) => ev.push(['update', i, t]),
    truncate: (n) => ev.push(['truncate', n]),
    done: (s) => ev.push(['done', s.length, c.now()]),
  }, opts);
  return { c, ev, p };
}

test('player: a final reply of 4 messages comes out one by one, in order, with typing gaps', () => {
  const { c, ev, p } = harness();
  p.feed('r1', Seg.plan('😝\n在吗？\n有点想你了。\n在干什么？', { final: true }), true);
  // the first at once, then she types the next
  assert.deepEqual(ev, [['reveal', 0, '😝', 0], ['typing', 1, 0]]);
  assert.equal(c.pending(), 1);
  c.advance(10000);
  const reveals = ev.filter((e) => e[0] === 'reveal');
  assert.deepEqual(reveals.map((e) => e[2]), ['😝', '在吗？', '有点想你了。', '在干什么？']);
  assert.deepEqual(reveals.map((e) => e[3]), [0, 560, 1360, 2080]); // 560 / 800 / 720 ms apart
  // a typing indicator before each later one
  assert.deepEqual(ev.filter((e) => e[0] === 'typing').map((e) => e[1]), [1, 2, 3]);
  assert.deepEqual(ev[ev.length - 1], ['done', 4, 2080]);
  assert.equal(c.pending(), 0);
  assert.equal(p.active(), false);
  // the same final again does nothing
  p.feed('r1', Seg.plan('😝\n在吗？\n有点想你了。\n在干什么？', { final: true }), true);
  assert.equal(ev.filter((e) => e[0] === 'reveal').length, 4);
});

test('player: a reply that streams in all at once (lh today) is still paced', () => {
  const { c, ev, p } = harness();
  const text = '🥺\n在吗？\n有点想你了。\n在干什么呀？';
  p.feed('r1', Seg.plan(text), false);
  p.feed('r1', Seg.plan(text, { final: true }), true);
  assert.equal(ev.filter((e) => e[0] === 'reveal').length, 1);
  c.advance(600);
  assert.equal(ev.filter((e) => e[0] === 'reveal').length, 2); // 在吗？ after 560 ms of typing
  c.advance(10000);
  assert.deepEqual(ev.filter((e) => e[0] === 'reveal').map((e) => e[2]), ['🥺', '在吗？', '有点想你了。', '在干什么呀？']);
});

test('player: while streaming, the first line shows live; a later open line is 「正在输入」 and its typing time counts', () => {
  const { c, ev, p } = harness();
  p.feed('r1', Seg.plan('在'), false);
  p.feed('r1', Seg.plan('在吗'), false);
  assert.deepEqual(ev, [['live', 0, '在'], ['live', 0, '在吗']]);
  c.advance(100);
  p.feed('r1', Seg.plan('在吗？\n有'), false); // line 0 ended: it was on screen, so no typing for it
  assert.deepEqual(ev.slice(2), [['reveal', 0, '在吗？', 100], ['typing', 1, 100]]);
  c.advance(300);
  p.feed('r1', Seg.plan('在吗？\n有点想'), false);
  assert.equal(ev.length, 4, 'the open line is not shown as text, she is still typing it');
  c.advance(200); // 600 ms of typing so far
  p.feed('r1', Seg.plan('在吗？\n有点想你了。\n在'), false);
  // 有点想你了。 needs 800 ms of typing; she started at 100, so 300 ms are left
  assert.equal(ev.filter((e) => e[0] === 'reveal').length, 1);
  c.advance(299);
  assert.equal(ev.filter((e) => e[0] === 'reveal').length, 1);
  c.advance(1);
  assert.deepEqual(ev.filter((e) => e[0] === 'reveal').pop(), ['reveal', 1, '有点想你了。', 900]);
  c.advance(5000); // typed long enough: when the line ends it comes at once
  p.feed('r1', Seg.plan('在吗？\n有点想你了。\n在干什么？', { final: true }), true);
  assert.deepEqual(ev.slice(-2), [['reveal', 2, '在干什么？', 5900], ['done', 3, 5900]]);
  assert.equal(c.pending(), 0);
});

test('player: the final text corrects what was shown (tool preamble) in place, and can shrink to one message', () => {
  const { c, ev, p } = harness();
  p.feed('r1', Seg.plan('我看看\n\n'), false);
  p.feed('r1', Seg.plan('我看看\n\n找到了'), false);
  c.advance(3000);
  assert.equal(p.state().typing, 1); // 「正在输入」 for the line after the preamble
  p.feed('r1', Seg.plan('找到了', { final: true }), true);
  assert.equal(p.state().typing, -1);
  assert.deepEqual(ev.filter((e) => e[0] === 'update' || e[0] === 'truncate' || e[0] === 'done').map((e) => e.slice(0, 3)), [['update', 0, '找到了'], ['done', 1, 3000]]);
  assert.equal(c.pending(), 0);
});

test('player: cancel (a new message, Esc) leaves no timer; nothing more is revealed; a new id starts over', () => {
  const { c, ev, p } = harness();
  p.feed('r1', Seg.plan('一\n二\n三\n四\n五', { final: true }), true);
  c.advance(700);
  const r = p.cancel('new-message');
  assert.deepEqual(r, { id: 'r1', shown: 2, total: 5, dropped: 3, reason: 'new-message' });
  assert.equal(c.pending(), 0);
  c.advance(60000);
  assert.equal(ev.filter((e) => e[0] === 'reveal').length, 2);
  assert.equal(p.active(), false);
  assert.equal(p.cancel('again'), null);
  // a new reply while one is still playing: the old timer goes, the new one starts from its first message
  p.feed('r2', Seg.plan('甲\n乙\n丙', { final: true }), true);
  c.advance(200);
  p.feed('r3', Seg.plan('A\nB', { final: true }), true);
  assert.equal(c.pending(), 1);
  c.advance(60000);
  assert.deepEqual(ev.filter((e) => e[0] === 'reveal').slice(2).map((e) => e[2]), ['甲', 'A', 'B']);
  assert.equal(c.pending(), 0);
});

test('player: a hook that throws does not break the schedule', () => {
  const c = clock();
  const seen = [];
  const p = Seg.createPlayer({ setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, random: () => 0.5, reveal: (i) => { seen.push(i); throw new Error('boom'); } });
  p.feed('r', Seg.plan('a\nb\nc', { final: true }), true);
  c.advance(10000);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(p.state().done, true);
});

test('settings: 分段式表达 is on by default; its cap and pace are kept in range', () => {
  const s = settings.normalizeSettings(null);
  assert.equal(s.prefs.segmented, true);
  assert.equal(s.prefs.segmentMax, 6);
  assert.equal(s.prefs.segmentCharMs, 80);
  const t = settings.normalizeSettings({ prefs: { segmented: false, segmentMax: 4, segmentCharMs: 120 } });
  assert.deepEqual([t.prefs.segmented, t.prefs.segmentMax, t.prefs.segmentCharMs], [false, 4, 120]);
  const bad = settings.normalizeSettings({ prefs: { segmented: 'yes', segmentMax: 20, segmentCharMs: 5.5 } });
  assert.deepEqual([bad.prefs.segmented, bad.prefs.segmentMax, bad.prefs.segmentCharMs], [true, 6, 80]);
  const schema = require('../src/core/settings-schema');
  assert.equal(schema.validate('prefs.segmentMax', 9).ok, false);
  assert.deepEqual(schema.validate('prefs.segmentMax', 4), { ok: true, value: 4 });
  assert.deepEqual(schema.patchFor('prefs.segmented', false), { setter: 'setPrefs', patch: { segmented: false } });
});

test('persona: the system role asks for short messages one per line in a playful, close tone; off removes it', () => {
  const on = persona.buildSystemRole({ speciesId: 'claude', name: '小芽', settings: settings.normalizeSettings(null) });
  assert.match(on, /每条单独一行/);
  assert.match(on, /调皮/);
  assert.match(on, /核心是自然/);
  assert.match(on, /一句就够就只发一条/); // one message is a normal reply: not told to always split
  assert.match(on, /\[节奏\]/);
  assert.match(on, /不要每次都拿表情开头/);
  assert.doesNotMatch(on, /拆成 2–/);
  assert.match(on, /🥺\n {4}在吗？\n {4}有点想你了。/); // the long form is still there when the moment calls for it
  assert.match(on, /下午三点二十。/); // and it is not the only example
  assert.match(on, /连发到 5 条/);
  assert.match(on, /6 条封顶/);
  const s4 = settings.normalizeSettings({ prefs: { segmentMax: 4 } });
  assert.match(persona.buildSystemRole({ speciesId: 'claude', name: '小芽', settings: s4 }), /连发到 4 条/);
  const off = settings.normalizeSettings({ prefs: { segmented: false } });
  assert.doesNotMatch(persona.buildSystemRole({ speciesId: 'claude', name: '小芽', settings: off }), /每条单独一行/);
  // turning it on / off or changing the cap updates her agent's role (personaKey)
  const pet = { speciesId: 'claude', name: '小芽', relStage: 'stranger', peakStage: 'stranger', affection: 0 };
  const keys = new Set([settings.normalizeSettings(null), s4, off].map((x) => persona.personaKey(pet, x)));
  assert.equal(keys.size, 3);
});

test('rhythm: each owner message rolls how much she feels like saying; a long absence makes a burst likely; off adds nothing', () => {
  const on = settings.normalizeSettings(null);
  const now = 1e12;
  const near = { lastInteractionAt: now - 60000 };
  const far = { lastInteractionAt: now - 3 * 86400000 };
  const seq = (...v) => () => v.shift();
  assert.equal(persona.rhythmHint(near, now, on, seq(0.05, 0.1)), '[节奏] 这次话有点多，连发 4–5 条短消息，其中一条可以只发一个表情。');
  assert.equal(persona.rhythmHint(near, now, on, seq(0.3, 0.9)), '[节奏] 这次就回一条，一句话接住就好，不用表情。');
  assert.equal(persona.rhythmHint(near, now, on, seq(0.3, 0.1)), '[节奏] 这次就回一条，一句话接住就好，带个表情。');
  assert.equal(persona.rhythmHint(near, now, on, seq(0.9, 0.9)), '[节奏] 这次有两三句想说，分 2–3 条发，不用表情。');
  assert.match(persona.rhythmHint(far, now, on, seq(0.5, 0.9)), /连发 4–5 条/); // not for someone who was just here
  assert.match(persona.rhythmHint(near, now, on, seq(0.5, 0.9)), /就回一条/);
  assert.match(persona.rhythmHint(near, now, settings.normalizeSettings({ prefs: { segmentMax: 3 } }), seq(0.05, 0.9)), /连发 3 条/);
  assert.equal(persona.rhythmHint(near, now, settings.normalizeSettings({ prefs: { segmented: false } })), '');
  // over many rolls it is a mix, and never one shape
  let n = 0;
  const rnd = () => { n = (n * 9301 + 49297) % 233280; return n / 233280; };
  const hints = Array.from({ length: 400 }, () => persona.rhythmHint(near, now, on, rnd));
  const share = (re) => hints.filter((h) => re.test(h)).length / hints.length;
  assert.ok(share(/就回一条/) > 0.35 && share(/就回一条/) < 0.65, `one: ${share(/就回一条/)}`);
  assert.ok(share(/连发/) > 0.03 && share(/连发/) < 0.25, `burst: ${share(/连发/)}`);
  assert.ok(share(/不用表情/) > 0.5);
  // it reaches the turn's prompt, right before her owner's words
  const pet = require('../src/core/pet-state').createPet({ speciesId: 'claude', name: 'E', agentId: 'a', now });
  assert.match(persona.buildChatPrompt('嗨', pet, now, { settings: on, rnd: seq(0.9, 0.9) }), /\[节奏\] 这次有两三句想说，分 2–3 条发，不用表情。\n嗨$/);
  assert.doesNotMatch(persona.buildChatPrompt('嗨', pet, now, { settings: settings.normalizeSettings({ prefs: { segmented: false } }) }), /\[节奏\]/);
  // the absence is the one from before this message: her state block says so and a burst is likely
  const back = persona.buildChatPrompt('嗨', pet, now, { settings: on, lastSeenAt: now - 3 * 86400000, rnd: seq(0.5, 0.9) });
  assert.match(back, /距上次互动4320分钟/);
  assert.match(back, /连发 4–5 条/);
});
