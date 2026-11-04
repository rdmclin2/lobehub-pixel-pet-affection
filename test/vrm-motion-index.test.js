'use strict';
// T-5081: the motion library index (src/core/vrm-motion-index.json), the bone maps and the missing-bone fold
// (src/core/vrm-bone-map.js), the selection rules (scripts/lib/vrm-motion-rules.js) and the loop seams of the bake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BM = require('../src/core/vrm-bone-map');
const L = require('../src/core/vrm-library');
const Rules = require('../scripts/lib/vrm-motion-rules');
const Core = require('../scripts/lib/vrm-bake-core');
const Retarget = require('../src/core/vmd-retarget');
const Select = require('../scripts/vrm-motion-select');
const Bake = require('../scripts/vrm-bake');

const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
const STYLES = ['female', 'male', 'neutral'];
const q = (axis, deg) => { const r = (deg * Math.PI) / 360; return [axis[0] * Math.sin(r), axis[1] * Math.sin(r), axis[2] * Math.sin(r), Math.cos(r)]; };
const angle = (a, b) => { const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]); return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI; };

// ---------- bone maps ----------
test('Mixamo map covers every VRM humanoid bone and the bake uses the same table', () => {
  const mapped = new Set(Object.values(BM.MIXAMO_TO_VRM));
  for (const b of BM.VRM_BONES) assert.ok(mapped.has(b), `Mixamo → ${b}`);
  assert.equal(Core.MIXAMO_TO_VRM, BM.MIXAMO_TO_VRM);
  assert.equal(BM.vrmOfMixamo('mixamorig:LeftForeArm'), 'leftLowerArm');
  assert.equal(BM.vrmOfMixamo('mixamorigRightHandPinky2'), 'rightLittleIntermediate');
  assert.equal(BM.vrmOfMixamo('mixamorig1:Spine2'), 'upperChest');
  assert.equal(BM.vrmOfMixamo('mixamorig:HeadTop_End'), null);
  for (const r of BM.VRM_REQUIRED) assert.ok(BM.VRM_BONES.includes(r));
});

test('MMD map agrees with the VMD retarget (vmd-retarget BONE_ROLE) on every bone it names', () => {
  for (const [mmd, vrm] of Object.entries(BM.MMD_TO_VRM)) {
    const role = Retarget.BONE_ROLE[mmd];
    assert.ok(role, `${mmd} is read by vmd-retarget`);
    assert.equal(role.split(' ')[0], vrm, mmd);
  }
  // fingers, the twist bones and the leg IK land where the retarget puts them
  assert.equal(BM.MMD_TO_VRM['左腕捩'], 'leftUpperArm');
  assert.equal(BM.MMD_TO_VRM['右人指2'], 'rightIndexIntermediate');
  assert.equal(BM.MMD_TO_VRM['左足ＩＫ'.replace('ＩＫ', 'IK')], 'leftFoot');
  // VRM 0.x thumb names → 1.0 (applied by three-vrm)
  assert.equal(BM.VRM0_THUMB.leftThumbProximal, 'leftThumbMetacarpal');
  assert.equal(BM.VRM0_THUMB.rightThumbIntermediate, 'rightThumbProximal');
});

test('foldMissing keeps the world rotation of every bone below a missing upperChest / neck / shoulder', () => {
  const tr = (qs) => ({ times: qs.map((_, i) => i), values: qs.flat() });
  const tracks = {
    hips: tr([[0, 0, 0, 1], [0, 0, 0, 1]]), spine: tr([q([1, 0, 0], 5), q([1, 0, 0], 10)]), chest: tr([q([0, 1, 0], 4), q([0, 1, 0], 8)]),
    upperChest: tr([q([1, 0, 0], 12), q([0, 0, 1], 20)]), neck: tr([q([0, 1, 0], 15), q([0, 1, 0], -15)]), head: tr([q([1, 0, 0], 10), q([1, 0, 0], 20)]),
    leftShoulder: tr([q([0, 0, 1], 8), q([0, 0, 1], 3)]), leftUpperArm: tr([q([0, 0, 1], 60), q([0, 0, 1], 70)]), rightShoulder: tr([[0, 0, 0, 1], [0, 0, 0, 1]]),
    leftToes: tr([q([1, 0, 0], 30), q([1, 0, 0], 30)]), leftIndexDistal: tr([q([0, 0, 1], 30), q([0, 0, 1], 30)]),
  };
  const world = (t, b, list) => { let w = [0, 0, 0, 1]; for (const x of list) if (t[x]) w = BM.qmul(w, BM.at(t[x], b)); return w; };
  const missing = new Set(['upperChest', 'neck', 'leftToes', 'leftIndexDistal']);
  const r = BM.foldMissing(tracks, (b) => !missing.has(b));
  assert.deepEqual(r.folded.map((f) => f[0]).sort(), ['neck', 'upperChest']);
  assert.ok(r.dropped.includes('leftToes') && r.dropped.includes('leftIndexDistal'));
  for (const m of missing) assert.equal(r.tracks[m], undefined);
  // exact on the keys; between keys the fold slerps the product (a 30 fps clip keys every frame)
  for (const t of [0, 1]) {
    // head: hips·spine·chest·upperChest·neck·head before, hips·spine·chest·head' after
    const before = world(tracks, t, ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head']);
    const after = world(r.tracks, t, ['hips', 'spine', 'chest', 'head']);
    assert.ok(angle(before, after) < 0.01, `head at ${t}: ${angle(before, after)}°`);
    const ab = world(tracks, t, ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm']);
    const aa = world(r.tracks, t, ['hips', 'spine', 'chest', 'leftShoulder', 'leftUpperArm']);
    assert.ok(angle(ab, aa) < 0.01, `left upper arm at ${t}`);
  }
  // a missing shoulder folds into the upper arm
  const r2 = BM.foldMissing(tracks, (b) => b !== 'leftShoulder');
  const wb = world(tracks, 1, ['upperChest', 'leftShoulder', 'leftUpperArm']);
  const wa = world(r2.tracks, 1, ['upperChest', 'leftUpperArm']);
  assert.ok(angle(wb, wa) < 0.01);
  // nothing missing: nothing changes
  const r3 = BM.foldMissing(tracks, () => true);
  assert.deepEqual(r3.folded, []);
  assert.equal(r3.tracks.head, tracks.head);
});

test('degrade levels and root-hips models (standing clips only)', () => {
  const all = new Set(BM.VRM_BONES);
  assert.equal(BM.degradeLevel(all), 'full');
  assert.equal(BM.degradeLevel((b) => b !== 'upperChest'), 'folded');
  assert.equal(BM.degradeLevel((b) => !/Index/.test(b)), 'no-fingers');
  assert.equal(BM.degradeLevel((b) => b !== 'leftFoot'), 'unusable');
  assert.equal(BM.rootHips(0, 1.39), true); // Wanderer: the humanoid hips is a root on the floor
  assert.equal(BM.rootHips(0.89, 1.37), false); // liliya
  const sit = { group: 'sit', enter: 'sit', exit: 'sit' };
  const sinks = { group: 'sad', enter: 'stand', exit: 'sit' };
  const nod = { group: 'nod', enter: 'stand', exit: 'stand' };
  assert.equal(BM.allowsClip(sit, { rootHips: true }), false);
  assert.equal(BM.allowsClip(sinks, { rootHips: true }), false);
  assert.equal(BM.allowsClip({ sit: true }, { rootHips: true }), false);
  assert.equal(BM.allowsClip(nod, { rootHips: true }), true);
  assert.equal(BM.allowsClip(sit, { rootHips: false }), true);
});

// ---------- the index ----------
test('the index is metadata only: schema 2, valid entries, relative sources, no binaries', () => {
  assert.equal(INDEX.schema, 2);
  assert.deepEqual(L.validateManifest({ schema: 1, clips: INDEX.clips }), []);
  const groups = Rules.CATEGORIES;
  for (const [id, e] of Object.entries(INDEX.clips)) {
    const { style } = L.parseId(id);
    assert.equal(e.style, style, id);
    assert.ok(L.CATEGORIES.includes(e.category), `${id}: category`);
    assert.ok(groups[e.category].includes(e.group) || (e.by === 'base' || e.by === 'base-neutral'), `${id}: group ${e.group} in ${e.category}`);
    if (e.cycle) continue;
    assert.match(e.src, /^(postures|mixamo|motions)\/[^\0]+\.(fbx|vmd)$/i, id);
    assert.ok(!e.src.includes('..') && !path.isAbsolute(e.src), id);
    assert.ok(['postures', 'mixamo', 'motions'].includes(e.pack), `${id}: pack`);
    assert.ok(e.duration > 0, `${id}: duration`);
    assert.ok(L.POSES.includes(e.enter) && L.POSES.includes(e.exit), `${id}: enter / exit`);
    if (e.kind === 'reaction' || e.kind === 'hold') assert.ok(L.MASKS.includes(e.mask), `${id}: mask`);
    if (e.by !== 'base' && e.by !== 'base-neutral') assert.equal(typeof e.loop, 'boolean', `${id}: loop`);
  }
  for (const [id, d] of Object.entries(INDEX.dances)) {
    assert.match(id, /^[a-z0-9-]{1,48}$/);
    assert.ok(d.styles.length && d.styles.every((s) => STYLES.includes(s)), id);
    assert.match(d.src, /^(mixamo|dances)\/[^\0]+\.(fbx|vmd)$/i, id);
  }
  // the fallback the runtime follows is the one the index declares
  assert.deepEqual(INDEX.styleFallback, L.STYLE_FALLBACK);
  // nothing in the JSON is an embedded binary (a data: URL or base64 blob)
  const text = fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8');
  assert.ok(!/data:|base64|[A-Za-z0-9+/]{200,}/.test(text));
});

test('every style has clips of every category, idle ≥ 6 and reactions ≥ 20, the named reactions all present', () => {
  const counts = Select.countsOf(INDEX);
  for (const s of STYLES) {
    for (const c of L.CATEGORIES) assert.ok(counts[s][c] >= 1, `${s} ${c}: ${counts[s][c]}`);
    assert.ok(counts[s].idle >= 6, `${s} idle ${counts[s].idle}`);
    assert.ok(counts[s].reaction + counts[s].emotion >= 20, `${s} reactions ${counts[s].reaction + counts[s].emotion}`);
    const groups = new Set(Object.values(INDEX.clips).filter((e) => e.style === s).map((e) => e.group));
    for (const g of ['greet', 'nod', 'shake', 'shy', 'happy', 'angry', 'surprised', 'think', 'talk', 'walk', 'stretch', 'yawn', 'stand', 'sit', 'crouch', 'lay']) assert.ok(groups.has(g), `${s} has ${g}`);
  }
  // postures come from each style's own gendered sources (male from the male poses, female from the female ones)
  for (const s of ['female', 'male']) {
    for (const g of Rules.CATEGORIES.posture) {
      const own = Object.values(INDEX.clips).filter((e) => e.style === s && e.group === g && e.srcStyle === s);
      assert.ok(own.length >= 1, `${s} ${g} from ${s} sources`);
    }
  }
  // every idle starts and ends standing; postures are held poses (kind posture), loops are idles / talk / walk
  for (const e of Object.values(INDEX.clips)) {
    if (e.category === 'idle' && e.src) assert.ok(e.enter === 'stand' && e.exit === 'stand', e.src);
    if (e.category === 'posture') assert.equal(e.kind, 'posture');
  }
});

test('any store VRM hits a clip: the runtime resolves every slot for every style, falling back neutral → female → male', () => {
  const lib = L.cleanIndex({ schema: 1, clips: Object.fromEntries(Object.entries(INDEX.clips).map(([id, e]) => [id, { ...e, file: e.src ? `${e.style}/${L.parseId(id).slot}.vrma` : undefined }])) });
  for (const s of STYLES) {
    assert.deepEqual(L.loadSets(lib, s), [s]);
    const cc = L.categoryCounts(lib, s);
    for (const c of ['posture', 'idle', 'reaction', 'emotion', 'talk', 'walk']) assert.ok(cc[c] > 0, `${s} ${c}`);
    assert.ok(L.variants(lib, 'nod', s).length >= 1);
  }
  // a library with only female clips: every set loads female, neutral resolves to female
  const only = { clips: { 'react.nod-01@female': { id: 'react.nod-01@female', slot: 'react.nod-01', style: 'female', kind: 'reaction', group: 'nod', file: 'female/a.vrma' }, 'react.nod-01@male': { id: 'react.nod-01@male', slot: 'react.nod-01', style: 'male', kind: 'reaction', group: 'nod', file: 'male/a.vrma' } } };
  assert.deepEqual(L.loadSets(only, 'neutral'), ['female']);
  assert.equal(L.resolve(only, 'react.nod-01', 'neutral').style, 'female');
  assert.equal(L.resolve({ clips: { 'x.a@male': only.clips['react.nod-01@male'] } }, 'x.a', 'female').style, 'male');
  assert.equal(L.variants(only, 'nod', 'neutral')[0].style, 'female');
  assert.deepEqual(L.STYLE_FALLBACK.male, ['male', 'neutral', 'female']);
});

// ---------- the selection rules ----------
const feat = (o = {}) => {
  const base = {
    duration: 6, keys: 180, static: false, seamDeg: 1, start: 'stand', end: 'stand', burst: { ratio: 1.2, at: 0.5 }, hipsBack: 0,
    hips: { heightMin: 0.97, heightMean: 0.99, heightMax: 1, bob: 0.01, travel: 0, path: 0.05, speed: 0, yawTurn: 0, yawRange: 5 },
    lean: { mean: 3, max: 6 }, torsoPitch: { mean: 1, max: 3, range: 4 },
    head: { pitchRange: 5, yawRange: 6, pitchSwings: 0, yawSwings: 0, pitchMean: 0, pitchMax: 3, pitchMin: -2 },
    hands: { upMax: -0.5, bothUpFrac: 0, oneUpFrac: 0, faceMin: 0.5, faceFrac: 0, apartMin: 0.4, apartMean: 0.45, togetherFrac: 0, frontMax: 0.05, lowMean: -0.05, wave: 0, travel: 0.1 },
    feet: { lift: 0.01, strideSwings: 0, strideRange: 0.02 }, energy: { arms: 10, legs: 8, head: 5, spine: 3 },
  };
  const out = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  return out;
};
const top = (f) => (Rules.rulesOf(f)[0] || {}).group;

test('rules: idle, walk, nod, shake, wave, stretch, yawn, think, talk, postures', () => {
  assert.equal(top(feat()), 'idle');
  assert.equal(top(feat({ duration: 1.2, feet: { strideRange: 1, strideSwings: 2, lift: 0.05 }, hips: { speed: 0.9, travel: 1.1, path: 1.1 }, energy: { arms: 60, legs: 100 } })), 'walk');
  assert.equal(top(feat({ duration: 0.7, feet: { strideRange: 1.2, strideSwings: 2 }, hips: { speed: 2.5, travel: 1.8, path: 1.8 }, energy: { legs: 200 } })), 'run');
  assert.equal(top(feat({ head: { pitchSwings: 4, pitchRange: 22, yawRange: 4 } })), 'nod');
  assert.equal(top(feat({ head: { yawSwings: 4, yawRange: 40, pitchRange: 6 } })), 'shake');
  assert.equal(top(feat({ hands: { wave: 5, oneUpFrac: 0.6, upMax: 0.1 }, energy: { arms: 80 } })), 'greet');
  assert.equal(top(feat({ hands: { bothUpFrac: 0.5, upMax: 0.3 }, energy: { arms: 40 } })), 'stretch');
  assert.equal(top(feat({ duration: 8, hands: { faceFrac: 0.3, faceMin: 0.05 }, head: { pitchMin: -25, pitchRange: 28 }, energy: { arms: 30 } })), 'yawn');
  assert.equal(top(feat({ hands: { faceFrac: 0.6, faceMin: 0.05 }, energy: { arms: 20 } })), 'think');
  assert.equal(top(feat({ duration: 6, energy: { arms: 60, legs: 10 }, hands: { travel: 0.8, frontMax: 0.2, upMax: -0.2 } })), 'talk');
  // static poses: lay / sit / stand by the hips height and the lean
  assert.equal(top(feat({ static: true, keys: 2, duration: 0.03, lean: { mean: 85, max: 88 }, hips: { heightMax: 0.2 } })), 'lay');
  assert.equal(top(feat({ static: true, keys: 2, duration: 0.03, hips: { heightMax: 0.5 }, lean: { mean: 10 } })), 'sit');
  assert.equal(top(feat({ static: true, keys: 2, duration: 0.03, hips: { heightMax: 0.66 }, lean: { mean: 10 } })), 'crouch');
  assert.equal(top(feat({ static: true, keys: 2, duration: 0.03 })), 'stand');
  // a clip that travels or crouches is no idle / reaction
  assert.notEqual(top(feat({ hips: { heightMin: 0.5 } })), 'idle');
  assert.equal(Rules.rulesOf({ error: 'x' }).length, 0);
});

test('rules: the label wins over the features, the review over both, fights / adult / helper motions are out', () => {
  const f = feat();
  assert.equal(Rules.classify('mixamo/a.fbx', f, { ref: { type: 'Motion', category: 'Greeting', description: 'Quick Formal Bow', gender: 'Male' } }).group, 'bow');
  assert.equal(Rules.classify('mixamo/a.fbx', f, { ref: { type: 'Posture', category: 'Laying', gender: 'Female' } }).group, 'lay');
  assert.equal(Rules.classify('mixamo/a.fbx', f, { ref: { type: 'Posture', category: 'Action' } }), null);
  assert.equal(Rules.classify('mixamo/a.fbx', f, { ref: { type: 'Motion', category: 'Dance', description: 'Salsa' } }).category, 'dance');
  assert.equal(Rules.classify('motions/x.vmd', f, { review: { group: 'shy' } }).group, 'shy');
  assert.equal(Rules.classify('mixamo/a.fbx', f, { review: { reject: true } }), null);
  for (const t of ['Sword And Shield Slash', 'Zombie Idle', 'Boxing', 'Rifle Run']) assert.equal(Rules.classify('mixamo/a.fbx', f, { ref: { type: 'Motion', description: t } }), null, t);
  assert.equal(Rules.classify('motions/PO_chest.vmd', f, {}), null);
  assert.equal(Rules.classify('mixamo/a.fbx', f, { text: 'NO 战斗动作 combat' }), null);
  assert.deepEqual(Rules.stylesOf({ gender: 'Female' }), ['female', 'neutral']);
  assert.deepEqual(Rules.stylesOf({ gender: 'Male' }), ['male']);
  assert.deepEqual(Rules.stylesOf(null), ['female', 'male', 'neutral']);
  // slot names follow the runtime's id rules
  assert.equal(Select.slotOf('reaction', 'nod', 3), 'react.nod-03');
  assert.equal(Select.slotOf('emotion', 'shy', 1), 'emote.shy-01');
  assert.equal(Select.slotOf('talk', 'talk', 2), 'hold.talk-g02');
  assert.equal(Select.slotOf('posture', 'lay', 1), 'lay.v01');
  assert.equal(Select.maskOf('reaction', 'nod'), 'head');
  assert.equal(Select.loopOf('reaction', 'nod'), false);
  assert.equal(Select.loopOf('idle', 'idle'), true);
});

test('the features: oscillation counts and seams', () => {
  const F = require('../scripts/lib/vrm-motion-features');
  assert.equal(F.swings([0, 1, 0, 1, 0], 0.5), 3);
  assert.equal(F.swings([0, 0.1, 0.2, 0.1], 0.5), 0);
  assert.equal(F.swings([0.5, -0.5, 0.5], 0.08), 1);
});

// ---------- loops ----------
test('a loop is continuous across its seam after the bake (loopClip), and a facing-aside clip is turned to the front', () => {
  const tr = { times: [0, 0.5, 1, 1.5, 2], values: [q([0, 1, 0], 0), q([0, 1, 0], 20), q([0, 1, 0], 40), q([0, 1, 0], 50), q([0, 1, 0], 60)] };
  const clip = { duration: 2, bones: { hips: { times: tr.times, values: tr.values.map(() => [0, 0, 0, 1]) }, head: tr }, hips: { times: [0, 2], values: [[0, 1, 0], [0.2, 1, 0]] }, restHipsY: 1 };
  assert.ok(Core.seamAngle(clip) > 50);
  const looped = Core.bakeParams(clip, { kind: 'idle', loop: true });
  assert.ok(Core.seamAngle(looped) <= Bake.LOOP_SEAM_MAX, `seam ${Core.seamAngle(looped)}`);
  const h = looped.hips.values;
  assert.ok(Math.hypot(h[0][0] - h[h.length - 1][0], h[0][2] - h[h.length - 1][2]) < 1e-6);
  const aside = { duration: 1, bones: { hips: { times: [0, 1], values: [q([0, 1, 0], 80), q([0, 1, 0], 90)] } }, hips: { times: [0, 1], values: [[0, 1, 0], [1, 1, 0]] }, restHipsY: 1 };
  const front = Core.faceFrontClip(aside);
  assert.ok(Math.abs(front.faced - 85) < 0.5);
  assert.ok(Math.abs((Core.yawOf(front.bones.hips.values[0]) * 180) / Math.PI + 5) < 0.5);
  assert.equal(Core.faceFrontClip({ ...aside, bones: { hips: { times: [0], values: [[0, 0, 0, 1]] } } }).faced, undefined);
});

const BAKED = process.env.PIXELPET_VRM_MOTIONS_DIR || path.join(os.homedir(), 'vrm-assets', 'baked-v2');
test('the baked library (when present): every loop clip’s first and last frames meet, every file is where the index says', { skip: !fs.existsSync(path.join(BAKED, 'library.json')) && 'no baked library on this machine' }, () => {
  const lib = JSON.parse(fs.readFileSync(path.join(BAKED, 'library.json'), 'utf8'));
  if (lib.generator !== 'scripts/vrm-bake.js --v2') return;
  const clean = L.cleanIndex(lib);
  assert.equal(Object.keys(clean.clips).length, Object.keys(lib.clips).length, 'every entry survives the runtime check');
  let loops = 0;
  for (const [id, c] of Object.entries(lib.clips)) {
    if (!c.file) continue;
    const file = path.join(BAKED, c.file);
    assert.ok(fs.existsSync(file), id);
    if (!c.loop || c.kind === 'posture') continue;
    const { tracks } = Core.readVrma(fs.readFileSync(file));
    let worst = 0;
    for (const [name, t] of Object.entries(tracks)) {
      if (!name.endsWith('.rotation') || t.values.length < 8) continue;
      const n = t.values.length;
      worst = Math.max(worst, angle(t.values.slice(0, 4), t.values.slice(n - 4)));
    }
    assert.ok(worst <= Bake.LOOP_SEAM_MAX + 0.05, `${id}: seam ${worst.toFixed(2)}°`);
    loops++;
  }
  assert.ok(loops >= 20, `${loops} loops checked`);
  for (const s of STYLES) for (const c of ['posture', 'idle', 'reaction', 'emotion', 'talk', 'walk', 'dance']) assert.ok(lib.counts[s][c] >= 1, `${s} ${c}`);
});

test('the index is reproducible from the scan (when the assets are on this machine)', { skip: !fs.existsSync(path.join(os.homedir(), 'vrm-assets', '_scan', 'features.json')) && 'no scan on this machine' }, () => {
  const built = Select.build({ assets: path.join(os.homedir(), 'vrm-assets'), scan: path.join(os.homedir(), 'vrm-assets', '_scan') });
  assert.equal(`${JSON.stringify(built, null, 2)}\n`, fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
});

test('no model, animation or audio is tracked by git or allowed into the package', () => {
  let files = [];
  try { files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'); } catch { return; }
  // (the app's own voice packs and test tones are its own recordings, not pack material)
  const bad = files.filter((f) => /\.(vrm|vrma|fbx|vmd|pmx|bvh|vroid|ncm)$/i.test(f) || (/\.(mp3|wav|ogg|m4a|flac)$/i.test(f) && !/^(src\/voicepacks|test\/fixtures)\//.test(f)));
  assert.deepEqual(bad, []);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const ex of ['!**/*.vrm', '!**/*.vrma', '!**/*.fbx', '!**/*.vmd', '!**/*.pmx']) assert.ok(pkg.build.files.includes(ex), ex);
  // the bake and the scan refuse to write inside the repository
  assert.throws(() => Bake.installLibrary(path.join(os.tmpdir(), 'nowhere'), ROOT), /inside the repository/);
});

test('install copies a baked library into <userData>/vrm-motions and <userData>/vrm-dances', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-lib-'));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-ud-'));
  fs.mkdirSync(path.join(out, 'female'));
  fs.writeFileSync(path.join(out, 'female', 'idle.v01.vrma'), 'x');
  fs.writeFileSync(path.join(out, 'library.json'), '{"schema":1,"clips":{}}');
  fs.mkdirSync(path.join(out, 'dances', 'd1'), { recursive: true });
  fs.writeFileSync(path.join(out, 'dances', 'library.json'), '{"schema":1,"dances":{}}');
  fs.writeFileSync(path.join(out, 'dances', 'd1', 'dance.vrma'), 'y');
  const r = Bake.installLibrary(out, ud);
  assert.ok(fs.existsSync(path.join(ud, 'vrm-motions', 'female', 'idle.v01.vrma')));
  assert.ok(fs.existsSync(path.join(ud, 'vrm-motions', 'library.json')));
  assert.ok(fs.existsSync(path.join(ud, 'vrm-dances', 'd1', 'dance.vrma')));
  assert.equal(r.motions.files, 2);
  // the app finds it there (src/main/vrm-library.js libraryDir, packaged)
  const { libraryDir } = require('../src/main/vrm-library');
  assert.deepEqual(libraryDir({ env: {}, userData: ud, packaged: true }), { dir: path.join(ud, 'vrm-motions'), source: 'userData' });
  assert.equal(path.basename(Bake.userDataDir()), require('../package.json').productName);
});
