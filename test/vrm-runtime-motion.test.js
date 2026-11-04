'use strict';
// T-5084: the VRM runtime on the motion library v2 (src/core/vrm-motion-index.json, T-5081) — any store VRM finds a
// library and a style (fallback, the body guess), the director's decisions over it (idle rotation without short
// repeats, posture bouts stand / sit / crouch / lay, reaction variants by touch zone / drag / sleep, think and talk
// segments, every base change cross-faded, a reaction ending back in the idle), and playing a clip by hand
// (director.play, POST /motion, a chat request) that a touch, stop() or reset() interrupts back to the idle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const MI = require('../src/core/vrm-motion-intent');
const api = require('../src/core/api');
const VL = require('../src/main/vrm-library');
const VD = require('../src/main/vrm-dances');
const { runtimeMeta } = require('../scripts/vrm-bake');

const ROOT = path.join(__dirname, '..');
const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
// the runtime index a v2 bake writes (scripts/vrm-bake.js --v2): every clip of the index "baked" for its style.
// keep(id): which entries the library has (a library without a style, a model that only takes standing clips…)
function v2Index(keep = () => true) {
  const clips = {};
  for (const [id, e] of Object.entries(v2.clips)) {
    if (!keep(id, e)) continue;
    const { slot, style } = L.parseId(id);
    clips[id] = e.cycle ? { kind: e.kind, style, cycle: e.cycle, every: e.every, group: e.group, category: e.category } : { ...e, ...runtimeMeta(e), file: `${style}/${slot}.vrma`, duration: e.duration };
  }
  return L.cleanIndex({ clips });
}
const allLoaded = (index) => new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id));
const holdsOf = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: false, facing: 'right', ...o });
function make(style = 'female', opts = {}) {
  const index = opts.index || v2Index();
  return D.createDirector({ style: opts.profile || S.resolveStyle({ packStyle: { base: style } }), index, loaded: opts.loaded || allLoaded(index), rand: D.seeded(opts.seed || 11), posture: opts.posture, boredAfter: opts.boredAfter });
}
function run(d, seconds, holds = holdsOf(), at = {}, dt = 0.05) {
  const plans = [];
  const due = Object.entries(at).map(([k, v]) => ({ t: Number(k), ev: v, done: false }));
  let t0 = 0;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const events = [];
    for (const x of due) if (!x.done && t >= x.t - 1e-9) { x.done = true; events.push(...x.ev); }
    const p = d.update(dt, { holds: typeof holds === 'function' ? holds(t) : holds, events });
    plans.push({ ...p, at: t0 + t });
  }
  return plans;
}
const touch = (zone, mood = 'happy') => ({ type: 'touch', zone, mood });
const styleOf = (id) => (id ? id.split('@')[1] : null);

// ---------- 1) any store VRM finds a library and a style ----------
test('style fallback: a model of any style plays clips of the library — its own set, else the fallback chain (never the procedural idle)', () => {
  for (const [style, keep, want] of [
    ['female', () => true, 'female'],
    ['male', () => true, 'male'],
    ['neutral', () => true, 'neutral'],
    // an old library without a neutral set: neutral borrows female; without male: male borrows neutral
    ['neutral', (id) => !id.endsWith('@neutral'), 'female'],
    ['male', (id) => !id.endsWith('@male'), 'neutral'],
    ['female', (id) => id.endsWith('@male'), 'male'],
  ]) {
    const index = v2Index(keep);
    assert.deepEqual(L.loadSets(index, style), [want], `${style} → ${want}`);
    const d = make(style, { index, loaded: new Set(Object.values(index.clips).filter((c) => c.file && c.style === want).map((c) => c.id)) });
    const plans = run(d, 40);
    const idle = plans.filter((p) => p.idleKind === 'clip' || p.idleKind === 'cycle');
    assert.ok(idle.length / plans.length > 0.95, `${style}/${want}: idle clips ${idle.length}/${plans.length}`);
    assert.ok(plans.every((p) => p.idleKind !== 'micro'), `${style}/${want}: no procedural micro idle`);
    for (const p of plans) if (p.base && p.base.id && p.base.file) assert.equal(styleOf(p.base.id), want, `${style}: base ${p.base.id}`);
  }
});

test('style guess (core/vrm-style.js): unknown → neutral; a bust or a skirt spring on a narrow body → female; shoulders ≥ 1.55 × hips → male (Elysia / Liqu 1.52–1.54 no longer male)', () => {
  assert.equal(S.inferFromBody(null), 'neutral');
  assert.equal(S.resolveStyle({}).name, 'neutral');
  assert.equal(S.resolveStyle({ body: { bustSpring: 0, skirtSpring: 0, shoulderHip: null } }).name, 'neutral');
  assert.equal(S.inferFromBody({ bustSpring: 4, shoulderHip: 1.6 }), 'female');
  assert.equal(S.inferFromBody({ bustSpring: 0, skirtSpring: 3, shoulderHip: 1.33 }), 'female');
  assert.equal(S.inferFromBody({ bustSpring: 0, skirtSpring: 0, shoulderHip: 1.54 }), 'neutral', 'Elysia');
  assert.equal(S.inferFromBody({ bustSpring: 0, skirtSpring: 0, shoulderHip: 1.52 }), 'neutral', 'Liqu');
  assert.equal(S.inferFromBody({ bustSpring: 0, skirtSpring: 0, shoulderHip: 1.57 }), 'male', 'Vrchat Avatar');
  assert.equal(S.inferFromBody({ bustSpring: 0, skirtSpring: 2, shoulderHip: 2.06 }), 'male', 'a robe on broad shoulders (Xingqiu)');
  assert.equal(S.resolveStyle({ packStyle: { base: 'male', overrides: {} }, body: { bustSpring: 4 } }).name, 'male', 'pack.json wins');
  // the spring reading itself, from a VRM 1.0 and a 0.x JSON
  const j1 = { nodes: [{ name: 'Skirt_01' }, { name: 'J_Sec_L_Bust1' }, { name: 'Hair' }], extensions: { VRMC_springBone: { springs: [{ joints: [{ node: 0 }, { node: 2 }] }] } } };
  assert.deepEqual(S.bodyFromJson(j1), { bustSpring: 0, skirtSpring: 1, shoulderHip: null });
  const j0 = { nodes: [{ name: 'root', children: [1] }, { name: 'スカート', children: [2] }, { name: 'スカート_end' }], extensions: { VRM: { secondaryAnimation: { boneGroups: [{ bones: [1] }] } } } };
  assert.equal(S.bodyFromJson(j0).skirtSpring, 2);
});

test('the library folder (src/main/vrm-library.js): env › the linked folder › userData › ~/vrm-assets/baked-v2 › baked on a dev run; nothing → source "none" with where it looked', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't5084-home-'));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 't5084-ud-'));
  const lib = (d) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'library.json'), JSON.stringify({ clips: { 'idle.v01@female': { kind: 'idle', file: 'female/idle.v01.vrma' } } })); return d; };
  // nothing anywhere: none, not "userData" (T-5079 R1 hid the missing library behind it)
  let w = VL.libraryDir({ env: {}, userData: ud, home });
  assert.equal(w.source, 'none');
  assert.equal(w.dir, path.join(ud, 'vrm-motions'));
  assert.ok(w.looked.includes(path.join(home, 'vrm-assets', 'baked-v2')));
  assert.match(VL.describe(VL.libraryStatus(w)), /no motion library \(looked in: .*vrm-motions.*baked-v2/);
  // the v2 bake before the old one on a dev run; never in a test run or the package
  lib(path.join(home, 'vrm-assets', 'baked'));
  assert.equal(VL.libraryDir({ env: {}, userData: ud, home }).dir, path.join(home, 'vrm-assets', 'baked'));
  lib(path.join(home, 'vrm-assets', 'baked-v2'));
  assert.deepEqual(VL.libraryDir({ env: {}, userData: ud, home }), { dir: path.join(home, 'vrm-assets', 'baked-v2'), source: 'dev' });
  assert.equal(VL.libraryDir({ env: { PIXELPET_TEST: '1' }, userData: ud, home }).source, 'none');
  assert.equal(VL.libraryDir({ env: {}, userData: ud, home, packaged: true }).source, 'none');
  // 选择文件夹: a pointer in userData; a parent of baked-v2 is taken as baked-v2; a folder without an index is refused
  const mine = lib(path.join(home, 'elsewhere', 'baked-v2'));
  assert.deepEqual(VL.writeLink(ud, path.join(home, 'nothing-here')), { ok: false, reason: 'no-index' });
  assert.deepEqual(VL.writeLink(ud, path.join(ROOT, 'src')), { ok: false, reason: 'inside-repo' });
  assert.deepEqual(VL.writeLink(ud, path.join(home, 'elsewhere')), { ok: true, dir: mine });
  assert.equal(VL.readLink(ud), mine);
  assert.deepEqual(VL.libraryDir({ env: {}, userData: ud, home, packaged: true }), { dir: mine, source: 'linked' }, 'the packaged app too');
  const st = VL.libraryStatus(VL.libraryDir({ env: {}, userData: ud, home, packaged: true }));
  assert.equal(st.files, 1);
  assert.deepEqual(st.styles, { female: 1 });
  // the linked folder's dances/ when the user has none of their own
  lib(path.join(mine, 'dances'));
  assert.deepEqual(VD.danceDir({ env: {}, userData: ud, home, packaged: true, link: mine }), { dir: path.join(mine, 'dances'), source: 'linked' });
  // env still wins; the link can be forgotten
  assert.equal(VL.libraryDir({ env: { PIXELPET_VRM_MOTIONS_DIR: home }, userData: ud, home }).source, 'env');
  assert.deepEqual(VL.writeLink(ud, null), { ok: true, dir: null });
  assert.equal(VL.readLink(ud), null);
});

// ---------- 2) the state machine over the library ----------
test('idle rotation: over 30 min no idle comes back within the last min(4, n/2) changes, and most of the pool is used', () => {
  for (const style of ['female', 'male', 'neutral']) {
    const d = make(style, { seed: 5 });
    // attention: no boredom, no rest break — the idle pool alone
    run(d, 1800, holdsOf({ attention: true }), {}, 0.1);
    const h = d.history();
    const pool = L.slotsOf(v2Index(), 'idle', style).length;
    const k = Math.min(D.IDLE_RECENT, Math.floor(pool / 2));
    assert.ok(h.length >= 50, `${style}: ${h.length} idles`);
    for (let i = 1; i < h.length; i++) assert.ok(!h.slice(Math.max(0, i - k), i).includes(h[i]), `${style}: ${h[i]} came back within ${k} at #${i}: ${h.slice(Math.max(0, i - k), i + 1)}`);
    assert.ok(new Set(h).size >= pool - 1, `${style}: ${new Set(h).size}/${pool} idles used`);
  }
});

test('every base change after the first is a cross-fade (fade > 0, longer for a change of pose) — never a snap', () => {
  const d = make('female', { seed: 3, boredAfter: 60 });
  const plans = run(d, 400, (t) => holdsOf({ mood: t > 300 && t < 340 ? 'sad' : 'idle' }), { 100: [touch('head')], 250: [touch('face')] }, 0.1);
  const changes = [];
  for (let i = 1; i < plans.length; i++) if (plans[i].base.key !== plans[i - 1].base.key) changes.push(plans[i].base);
  assert.ok(changes.length >= 10, `${changes.length} base changes`);
  for (const b of changes) assert.ok(b.fade >= 0.9, `${b.id}: fade ${b.fade}`);
  const poses = new Set(changes.map((b) => b.pose));
  for (const p of ['stand', 'sit', 'lay', 'crouch']) assert.ok(poses.has(p), `pose ${p} reached: ${[...poses]}`);
  for (const b of changes) if (b.pose === 'lay' || b.pose === 'crouch') assert.equal(b.fade, D.FADE.pose);
});

test('posture bouts (auto): a calm idle takes a rest break (sit / crouch) and stands up again; bored she sits, longer she lies down; sad she crouches; a pinned posture or a standing-only model stays standing', () => {
  // the rest break: 70–140 s into a calm idle, 18–36 s long
  let d = make('female', { seed: 9, boredAfter: 10000 });
  let plans = run(d, 400, holdsOf(), {}, 0.1);
  const rests = plans.filter((p) => p.rest);
  assert.ok(rests.length > 0, 'a rest break');
  const first = plans.findIndex((p) => p.rest);
  assert.ok(plans[first].at >= D.REST.after[0] - 0.2 && plans[first].at <= D.REST.after[1] + 0.2, `first break at ${plans[first].at}`);
  assert.ok(['sit', 'crouch'].includes(plans[first + 20].pose), plans[first + 20].pose);
  const back = plans.findIndex((p, i) => i > first && !p.rest);
  assert.ok(back > first && (plans[back].at - plans[first].at) <= D.REST.dur[1] + 0.2, 'she stands up again');
  assert.equal(plans[back + 20].pose, 'stand');
  assert.equal(plans[first + 20].action.state, 'idle', 'a rest is still the idle');
  // a talk (attention) ends the break at once
  d = make('female', { seed: 9, boredAfter: 10000 });
  run(d, plans[first].at + 3, holdsOf(), {}, 0.1);
  plans = run(d, 3, holdsOf({ attention: true, talk: true }), {}, 0.1);
  assert.equal(plans[plans.length - 1].rest, null);
  assert.equal(plans[plans.length - 1].pose, 'stand');
  // boredom: sit after boredAfter, lie down after twice that; any event stands her up
  d = make('female', { seed: 2, boredAfter: 60 });
  plans = run(d, 150, holdsOf(), {}, 0.1);
  assert.equal(plans.find((p) => p.at > 70).pose, 'sit');
  assert.equal(plans.find((p) => p.at > 70).postureSource, 'bored');
  assert.equal(plans[plans.length - 1].pose, 'lay');
  plans = run(d, 5, holdsOf(), { 0: [touch('head')] }, 0.1);
  assert.equal(plans[plans.length - 1].pose, 'stand');
  // sad: crouching (a group of the library), not the old stand.shy only
  d = make('male', { seed: 4 });
  plans = run(d, 5, holdsOf({ mood: 'sad', attention: true }), {}, 0.1);
  assert.equal(plans[plans.length - 1].pose, 'crouch');
  assert.match(plans[plans.length - 1].base.id, /^crouch\.v0\d@male$/);
  // pinned (the console's VRM 姿势): no break, no lying down
  d = make('female', { seed: 9, posture: 'stand.confident', boredAfter: 10000 });
  plans = run(d, 300, holdsOf(), {}, 0.1);
  assert.ok(plans.every((p) => p.pose === 'stand' && !p.rest));
  // a model whose hips sit on the floor loads standing clips only (vrm-bone-map allowsClip): she stays up
  const standOnly = v2Index((id, e) => !(e.kind === 'posture' && e.group !== 'stand'));
  d = make('female', { index: standOnly, seed: 9, boredAfter: 60 });
  plans = run(d, 300, holdsOf(), {}, 0.1);
  assert.ok(plans.every((p) => p.pose === 'stand'), [...new Set(plans.map((p) => p.pose))].join());
});

test('reactions: a touch / drag plays a moving clip of its slot or groups (nod, shy, clap, surprised…), not the same twice in a row, fits her pose, then fades back to the idle', () => {
  const d = make('female', { seed: 21 });
  run(d, 2, holdsOf({ attention: true }));
  const seen = [];
  for (const [zone, mood] of [['head', 'happy'], ['head', 'happy'], ['head', 'happy'], ['face', 'happy'], ['hands', 'happy'], ['head', 'shy'], ['head', 'annoyed']]) {
    const plans = run(d, 12, holdsOf({ attention: true }), { 0: [touch(zone, mood)] });
    const R = plans.find((p) => p.reaction);
    assert.ok(R, `${zone}/${mood}: a reaction`);
    const o = R.overlays.find((x) => x.layer === 'reaction');
    assert.ok(o, `${zone}/${mood}: a clip overlay`);
    const c = v2Index().clips[o.id];
    assert.ok(c.duration > 1.05, `${zone}/${mood}: ${o.id} moves (${c.duration} s)`);
    seen.push({ slot: R.reaction, id: o.id });
    // over: back in the idle, nothing left on her, the weights faded (no step)
    const last = plans[plans.length - 1];
    assert.equal(last.action.state, 'idle', `${zone}/${mood}: ${last.action.state}`);
    assert.equal(last.overlays.length, 0);
    const ws = plans.map((p) => (p.overlays.find((x) => x.layer === 'reaction' || x.layer === 'fading') || { weight: 0 }).weight);
    for (let i = 1; i < ws.length; i++) assert.ok(Math.abs(ws[i] - ws[i - 1]) < 0.35, `${o.id}: weight step ${ws[i - 1]} → ${ws[i]}`);
  }
  const heads = seen.filter((s) => s.slot === 'react.touch-head').map((s) => s.id);
  assert.equal(heads.length, 3);
  for (let i = 1; i < heads.length; i++) assert.notEqual(heads[i], heads[i - 1], `touch-head variants: ${heads}`);
  assert.ok(seen.some((s) => /emote\.shy-0\d|react\.shy/.test(s.id)), 'shy → a shy clip');
  assert.ok(seen.some((s) => /react\.shake-0\d|react\.annoyed/.test(s.id)), 'annoyed → a head shake');
  // a drop: surprised; sitting, a full-body standing clip is left out
  const p = run(d, 6, holdsOf({ attention: true }), { 0: [{ type: 'drag', what: 'drop' }] }).find((x) => x.reaction === 'react.drop');
  assert.ok(p && /emote\.surprised|react\.drop/.test(p.overlays.find((x) => x.layer === 'reaction').id));
  const sit = make('female', { seed: 5, posture: 'sit.rest' });
  run(sit, 3, holdsOf({ attention: true }));
  for (let i = 0; i < 4; i++) {
    const r = run(sit, 8, holdsOf({ attention: true }), { 0: [touch('head')] }).find((x) => x.reaction);
    const o = r.overlays.find((x) => x.layer === 'reaction');
    const c = v2Index().clips[o.id];
    assert.ok(c.mask !== 'full' || c.enter === 'sit', `sitting: ${o.id} (${c.mask}, enter ${c.enter})`);
  }
});

test('holds: thinking rotates the think gestures, a long reply the talk group (9 clips); falling asleep she yawns, waking up she stretches (upper body)', () => {
  const d = make('female', { seed: 8 });
  let plans = run(d, 25, holdsOf({ attention: true, think: true }));
  const think = new Set(plans.map((p) => p.thinkSegment).filter(Boolean));
  assert.ok(think.size >= 2, `think segments ${[...think]}`);
  assert.ok(plans.slice(40).every((p) => p.overlays.some((o) => /react\.think-0\d/.test(o.id))));
  plans = run(d, 40, holdsOf({ attention: true, talk: true }));
  const talk = new Set(plans.map((p) => p.talkSegment).filter(Boolean));
  assert.ok(talk.size >= 5, `talk segments ${[...talk]}`);
  assert.ok([...talk].some((s) => /hold\.talk-g0\d/.test(s)), 'the v2 talk clips');
  plans = run(d, 8, holdsOf({ mood: 'sleep' }));
  const yawn = plans.find((p) => p.reaction === 'react.yawn');
  assert.ok(yawn, 'a yawn');
  const yo = yawn.overlays.find((o) => o.layer === 'reaction');
  assert.match(yo.id, /react\.yawn-0\d@female/);
  assert.equal(yo.mask, 'upper', 'over the seated posture');
  assert.equal(plans[plans.length - 1].posture, 'sit.doze');
  plans = run(d, 8, holdsOf({ attention: true }));
  assert.ok(plans.some((p) => p.reaction === 'react.stretch'), 'a stretch');
});

// ---------- 3) playing a clip by hand ----------
test('director.play: a reaction / emotion as an overlay, a posture / idle as the base; one-shot back to the idle, loop until stopped; touch, stop(), reset() and a dance interrupt it', () => {
  const d = make('female', { seed: 3 });
  run(d, 2, holdsOf({ attention: true }));
  // by slot (her style), one-shot overlay
  let r = d.play({ slot: 'react.bow-01' });
  assert.deepEqual([r.ok, r.id, r.layer, r.loop], [true, 'react.bow-01@female', 'overlay', false]);
  let plans = run(d, 0.5, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].action.state, 'manual');
  assert.ok(plans[plans.length - 1].overlays.some((o) => o.id === 'react.bow-01@female'));
  plans = run(d, 8, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].action.state, 'idle', 'done → idle');
  assert.equal(plans[plans.length - 1].manual, null);
  assert.equal(d.manuals().slice(-1)[0].end, 'done');
  // by group, looped: keeps going until stopped
  r = d.play({ group: 'nod', loop: true });
  assert.ok(r.ok && /react\.nod-0\d@female/.test(r.id) && r.loop);
  plans = run(d, 20, holdsOf({ attention: true }));
  assert.ok(plans.every((p) => p.action.state === 'manual'), 'looping');
  const times = plans.map((p) => (p.overlays.find((o) => o.id === r.id) || {}).time);
  assert.ok(times.some((t, i) => i > 0 && t < times[i - 1]), 'the loop came round');
  assert.deepEqual(d.stopManual('test'), { stopped: true, id: r.id });
  plans = run(d, 2, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].action.state, 'idle');
  // a touch interrupts a manual overlay (it fades out under the touch reaction)
  r = d.play({ group: 'stretch', loop: true });
  run(d, 1, holdsOf({ attention: true }));
  plans = run(d, 1, holdsOf({ attention: true }), { 0: [touch('head')] });
  assert.equal(plans[plans.length - 1].action.state, 'touch');
  assert.ok(plans[2].overlays.some((o) => o.layer === 'fading' && o.id === r.id), 'the stretch fades out');
  assert.equal(d.manuals().slice(-1)[0].end, 'interrupted');
  run(d, 10, holdsOf({ attention: true }));
  // a posture by id: the base, held, cross-faded in; stop() → back to the idle pool (cross-faded out)
  r = d.play({ id: 'lay.v02@female', loop: true });
  assert.deepEqual([r.ok, r.layer], [true, 'base']);
  plans = run(d, 3, holdsOf({ attention: true }));
  const pb = plans[plans.length - 1].base;
  assert.deepEqual([pb.id, pb.pose, plans[plans.length - 1].action.state], ['lay.v02@female', 'lay', 'manual']);
  assert.equal(plans.find((p) => p.base.id === 'lay.v02@female').base.fade, D.FADE.pose);
  d.stop('test');
  plans = run(d, 3, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].pose, 'stand');
  assert.ok(plans[plans.length - 1].base.fade >= 1);
  assert.equal(plans[plans.length - 1].action.state, 'idle');
  // a posture one-shot: MANUAL.hold s; reset() (重置姿势) ends it earlier
  r = d.play({ slot: 'sit.v02' });
  plans = run(d, 4, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].base.id, 'sit.v02@female');
  assert.equal(d.reset('test').reset, true);
  plans = run(d, 3, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].pose, 'stand');
  assert.equal(plans[plans.length - 1].action.state, 'idle');
  // an idle clip by id
  r = d.play({ id: 'idle.v05@female' });
  plans = run(d, 2, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].base.id, 'idle.v05@female');
  plans = run(d, 10, holdsOf({ attention: true }));
  assert.equal(plans[plans.length - 1].manual, null, `one play of the idle (${v2Index().clips['idle.v05@female'].duration} s)`);
  // a dance takes over (the app stops the dance before playing; the director refuses while one is on)
  r = d.play({ group: 'clap', loop: true });
  plans = run(d, 1, holdsOf({ attention: true, dance: { id: 'x', playing: true, t: 0 } }));
  assert.equal(plans[plans.length - 1].manual, null);
  assert.equal(d.play({ group: 'clap' }).reason, 'dancing');
  // unknown / not loaded
  const e = make('female', { loaded: new Set() });
  assert.deepEqual(e.play({ id: 'react.bow-01@female' }), { ok: false, reason: 'no-clip' });
  assert.deepEqual(d.play({ slot: 'react.nothing' }), { ok: false, reason: 'no-clip' });
});

test('a male / neutral model plays its own set by hand, an id of another style resolves to its own', () => {
  const d = make('male', { seed: 1 });
  run(d, 1, holdsOf({ attention: true }));
  assert.equal(d.play({ id: 'react.bow-01@female' }).id, 'react.bow-01@female', 'an exact id is played as asked');
  d.stop();
  const n = make('neutral', { seed: 1 });
  run(n, 1, holdsOf({ attention: true }));
  assert.equal(n.play({ slot: 'react.bow-01' }).id, 'react.bow-01@neutral');
});

test('chat motion intent (core/vrm-motion-intent.js): 点个头 / 鞠个躬 / 伸个懒腰 / 坐下 / 站起来; dancing and negations are not motions', () => {
  const m = (t, o) => MI.matchMotionIntent(t, o);
  assert.deepEqual(m('点个头'), { action: 'play', group: 'nod', label: '点头' });
  assert.equal(m('给我鞠个躬吧').group, 'bow');
  assert.equal(m('伸个懒腰').group, 'stretch');
  assert.equal(m('挥挥手').group, 'greet');
  assert.equal(m('坐下休息一下').group, 'sit');
  assert.equal(m('躺下吧').group, 'lay');
  assert.equal(m('想一想').group, 'think');
  assert.deepEqual(m('站起来', { playing: true }), { action: 'stop' });
  assert.equal(m('站起来', { playing: false }), null);
  for (const t of ['跳个舞', '跳一下', '不要点头', '别鞠躬', '我不想坐下', '今天天气很好，我们一起去公园散步，路上见到邻居就点个头打招呼，然后再一起回来吃饭吧好不好呀']) assert.equal(m(t), null, t);
});

test('HTTP API: GET /motions, POST /motion (id | slot | group, loop, hold), POST /motion/stop — validated, answers from the pet window', async () => {
  for (const r of ['/motions', '/motion', '/motion/stop']) assert.ok(api.ROUTES.some(([, x]) => x === r), r);
  const calls = [];
  const ctx = {
    token: 't',
    motions: async () => ({ ok: true, library: { reason: 'ok', loaded: 3 }, motions: [{ id: 'react.nod-01@female' }], manual: null }),
    motion: async (o) => { calls.push(o); return o.slot === 'react.none' ? { ok: false, reason: 'no-clip' } : { ok: true, id: 'react.nod-01@female', slot: 'react.nod-01', kind: 'reaction', layer: 'overlay', label: '点头1', duration: 6, loop: !!o.loop }; },
    motionStop: async () => ({ ok: true, stopped: true, id: 'react.nod-01@female' }),
  };
  const req = (method, p, body = {}) => ({ method, path: `${api.PREFIX}${p}`, headers: { host: '127.0.0.1:7340', authorization: 'Bearer t' }, body });
  let r = await api.handle(req('GET', '/motions'), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.json.motions.length, 1);
  r = await api.handle(req('POST', '/motion', { group: 'nod', loop: true }), ctx);
  assert.deepEqual([r.status, r.json.id, r.json.loop], [200, 'react.nod-01@female', true]);
  assert.deepEqual(calls[0], { id: undefined, slot: undefined, group: 'nod', loop: true, hold: undefined });
  assert.equal((await api.handle(req('POST', '/motion', { slot: 'react.none' }), ctx)).status, 404);
  for (const bad of [{}, { id: '../x' }, { group: 'NOD!' }, { loop: 'yes', group: 'nod' }, { hold: 9999, slot: 'sit.v01' }]) assert.equal((await api.handle(req('POST', '/motion', bad), ctx)).status, 400, JSON.stringify(bad));
  r = await api.handle(req('POST', '/motion/stop'), ctx);
  assert.deepEqual(r.json, { ok: true, stopped: true, id: 'react.nod-01@female' });
});

test('a step in a clip\'s own keys (a source glitch) is spread over the frames around it; a smooth fast turn is left alone (core/vrm-bone-map.js smoothSteps)', () => {
  const BM = require('../src/core/vrm-bone-map');
  const qz = (deg) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
  const track = (angles, dt = 1 / 30) => ({ times: Float32Array.from(angles.map((_, i) => i * dt)), values: Float32Array.from(angles.flatMap(qz)) });
  const per30 = (t) => { const out = []; const a = [0, 0, 0, 0]; const b = [0, 0, 0, 0]; for (let x = t.times[0]; x + 1 / 30 <= t.times[t.times.length - 1] + 1e-6; x += 1 / 30) { BM._sampleQ(t.times, t.values, x, a); BM._sampleQ(t.times, t.values, x + 1 / 30, b); let d = 0; for (let c = 0; c < 4; c++) d += a[c] * b[c]; out.push((2 * Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI); } return out; };
  // a 60° step in one frame in the middle of a still pose → spread: no frame turns more than ~1/7 of it
  const step = track([...Array(15).fill(0), ...Array(15).fill(60)]);
  assert.ok(Math.max(...per30(step)) > 59);
  assert.ok(BM.smoothSteps(step.times, step.values) >= 1);
  const after = per30(step);
  assert.ok(Math.max(...after) <= 10, `max after ${Math.max(...after).toFixed(1)}°`);
  assert.ok(Math.abs((2 * Math.acos(step.values[step.values.length - 1]) * 180) / Math.PI - 60) < 0.01, 'the clip still ends at 60°');
  // a glitch into the very last key: the key holds the pose before it
  const end = track([...Array(10).fill(10), 80]);
  BM.smoothSteps(end.times, end.values);
  assert.ok(Math.max(...per30(end)) < 1);
  // irregular key times (3 ms apart, then 30 ms) are sampled as they play
  const irr = { times: Float32Array.from([0, 0.1, 0.103, 0.106, 0.136, 0.139, 0.3]), values: Float32Array.from([0, 0, 1, 2, 60, 61, 61].flatMap(qz)) };
  BM.smoothSteps(irr.times, irr.values);
  assert.ok(Math.max(...per30(irr)) <= 12, `irregular: ${Math.max(...per30(irr)).toFixed(1)}°`);
  // a fast but smooth turn (20°/frame, steady) is not a step: untouched
  const fast = track(Array.from({ length: 20 }, (_, i) => i * 20));
  const before = Array.from(fast.values);
  assert.equal(BM.smoothSteps(fast.times, fast.values), 0);
  assert.deepEqual(Array.from(fast.values), before);
});
