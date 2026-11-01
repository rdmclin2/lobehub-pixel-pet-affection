'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/core/packs');
const { SPECIES } = require('../src/core/species');
const { STATES, resolveAction } = require('../src/core/fx');

const BUILTIN = path.join(__dirname, '..', 'src', 'renderer', 'packs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function writePack(root, manifest, files = []) {
  const dir = path.join(root, manifest.id || 'x');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), PNG); }
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest));
  return dir;
}
const sprites = (over = {}) => ({ schema: 1, id: 'my-pack', name: 'Mine', species: 'grok', kind: 'sprites', pixelated: true, frame: { width: 10, height: 20 }, actions: { idle: { row: 0, col: 0, frames: 2, fps: 2 } }, outfits: { daily: 'a.png' }, ...over });

test('every built-in pack is valid, and every character has art for every outfit it offers', () => {
  const { packs, problems } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  assert.deepEqual(problems, []);
  assert.deepEqual([...packs.keys()].sort(), ['claude-adult', 'claude-classic', 'claude-pixel', 'dafeiyu-adult', 'dafeiyu-classic', 'dafeiyu-live', 'dafeiyu-live2d', 'dafeiyu-pixel', 'gemini-adult', 'gemini-classic', 'gemini-pixel', 'gpt-adult', 'gpt-classic', 'gpt-pixel', 'grok-adult', 'grok-classic', 'grok-pixel']);
  for (const id of ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']) {
    const sp = SPECIES[id];
    for (const p of sp.packs) assert.equal(packs.get(p).species, id, `${id} lists ${p}`);
    for (const outfit of sp.outfits) {
      const look = P.resolveLook(packs, { packId: P.chosenPack(packs, {}, id), fallbackId: P.fallbackPack(id), speciesId: id, outfitId: outfit });
      assert.ok(look, `${id}/${outfit}`);
    }
  }
});

test('the model-chan pixel packs are schema 2 and animate every state of the shared effects layer', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  for (const id of ['claude-pixel', 'grok-pixel', 'gemini-pixel', 'gpt-pixel', 'dafeiyu-pixel']) {
    const px = packs.get(id);
    assert.equal(px.schema, 2);
    assert.equal(px.kind, 'sprites');
    // `walk` included: a 4-frame side-view walk cycle facing right (art/model-chan/walk, scripts/art/add_walk_frames.py --from)
    assert.deepEqual(Object.keys(px.actions).sort(), [...STATES].sort(), `${id} animates every state`);
    for (const st of STATES) assert.equal(resolveAction(st, (n) => !!px.actions[n]).exact, true, `${id}/${st}`);
    assert.deepEqual(px.actions.walk, { row: 8, col: 0, frames: 4, fps: 5 }, 'a side-view walk cycle, not the idle art sliding along');
    assert.deepEqual(px.frame, { width: 664, height: 904 }, 'HD frames');
    assert.equal(px.pixelated, false, 'drawn smoothed, not as blocks');
    assert.match(px.outfits.daily, /\.webp$/);
  }
});

test('looks: the chosen pack, the character default, then its fallback pack; the video character picks its clips', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  assert.equal(P.chosenPack(packs, {}, 'grok'), 'grok-pixel');
  assert.equal(P.chosenPack(packs, { grok: 'claude-pixel' }, 'grok'), 'grok-pixel', "another character's pack is ignored");
  assert.equal(P.chosenPack(packs, { grok: 'gone' }, 'grok'), 'grok-pixel');
  assert.equal(P.chosenPack(packs, {}, 'dafeiyu'), 'dafeiyu-pixel', 'DeepSeek starts in pixels like everyone else');
  assert.equal(P.chosenPack(packs, { dafeiyu: 'dafeiyu-illustrated' }, 'dafeiyu'), 'dafeiyu-pixel', 'the retired outfit pack falls back');
  assert.equal(P.chosenPack(packs, { dafeiyu: 'dafeiyu-clips' }, 'dafeiyu'), 'dafeiyu-clips');
  assert.equal(P.chosenPack(packs, { grok: 'grok-clips' }, 'grok'), 'grok-pixel', 'a pack character has no clips');
  const l = P.resolveLook(packs, { packId: 'claude-pixel', fallbackId: 'claude-pixel', speciesId: 'claude', outfitId: 'daily' });
  assert.equal(l.kind, 'sprites');
  assert.equal(l.url, 'pack://claude-pixel/sheets/daily.webp');
  assert.equal(l.pixelated, false);
  assert.ok(l.actions.idle && l.actions.evolve && l.frame.width > 0);
  assert.equal(P.resolveLook(packs, { packId: 'dafeiyu-clips', fallbackId: 'dafeiyu-pixel', speciesId: 'dafeiyu', outfitId: 'daily' }), null, 'her clips');
  assert.equal(P.resolveLook(packs, { packId: 'dafeiyu-pixel', fallbackId: 'dafeiyu-pixel', speciesId: 'dafeiyu', outfitId: 'daily' }).packId, 'dafeiyu-pixel');
  const opts = P.packsFor(packs, 'dafeiyu');
  assert.deepEqual(opts.map((x) => [x.id, x.kind]), [['dafeiyu-pixel', 'sprites'], ['dafeiyu-live2d', 'live2d'], ['dafeiyu-live', 'rig'], ['dafeiyu-classic', 'sprites'], ['dafeiyu-clips', 'video']], 'the picker offers pixels, Live2D, the live rig, the old pixels and her clips');
  assert.equal(opts[4].author, 'PC2005-cloud/dsh-pet');
  assert.deepEqual(P.packsFor(packs, 'grok').map((x) => x.id), ['grok-pixel', 'grok-classic'], 'the default first');
});

test('every character keeps her v0.7.0 pixels as a 旧版像素 pack she can switch to, the new pack staying the default', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  for (const id of ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']) {
    const old = packs.get(`${id}-classic`);
    assert.equal(old.species, id);
    assert.match(old.name, /旧版像素$/);
    assert.deepEqual(old.frame, { width: 83, height: 113 }, 'the v0.7.0 frame size');
    assert.equal(Object.keys(old.actions).length, 17, 'every state animated, walking included');
    assert.equal(P.chosenPack(packs, {}, id), `${id}-pixel`, 'not the default');
    assert.equal(P.chosenPack(packs, { [id]: `${id}-classic` }, id), `${id}-classic`);
    assert.equal(P.resolveLook(packs, { packId: `${id}-classic`, fallbackId: `${id}-pixel`, speciesId: id, outfitId: 'daily' }).packId, `${id}-classic`);
  }
});

test('every outfit a character offers has its own sheet in her default pack (not only through a fallback)', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  for (const id of ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']) {
    const own = packs.get(SPECIES[id].packs[0]);
    for (const outfit of SPECIES[id].outfits) assert.ok(own.outfits[outfit] && fs.existsSync(path.join(BUILTIN, own.id, own.outfits[outfit])), `${own.id} has ${outfit}`);
  }
});

test("克洛蒂's swimsuit: her own sheet in the default pack, the same layout as daily; with 旧版像素 chosen it comes from the default pack", () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  const px = packs.get('claude-pixel');
  assert.equal(px.outfits.swimsuit, 'sheets/swimsuit.webp');
  const daily = P.resolveLook(packs, { packId: 'claude-pixel', fallbackId: 'claude-pixel', speciesId: 'claude', outfitId: 'daily' });
  const swim = P.resolveLook(packs, { packId: 'claude-pixel', fallbackId: 'claude-pixel', speciesId: 'claude', outfitId: 'swimsuit' });
  assert.equal(swim.url, 'pack://claude-pixel/sheets/swimsuit.webp');
  assert.deepEqual({ frame: swim.frame, actions: swim.actions }, { frame: daily.frame, actions: daily.actions });
  assert.equal(packs.get('claude-classic').outfits.swimsuit, undefined, 'no classic swimsuit art');
  const classic = P.resolveLook(packs, { packId: 'claude-classic', fallbackId: P.fallbackPack('claude'), speciesId: 'claude', outfitId: 'swimsuit' });
  assert.equal(classic.packId, 'claude-pixel');
  assert.equal(classic.url, swim.url);
  assert.equal(P.resolveLook(packs, { packId: 'claude-classic', fallbackId: P.fallbackPack('claude'), speciesId: 'claude', outfitId: 'daily' }).packId, 'claude-classic', 'daily stays classic');
});

test("大肥鱼's swimsuit: with 原版动画 chosen she wears her pixel pack's swimsuit sheet, and daily goes back to her clips", () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  assert.equal(packs.get('dafeiyu-pixel').outfits.swimsuit, 'sheets/swimsuit.webp');
  const pixel = P.resolveLook(packs, { packId: 'dafeiyu-pixel', fallbackId: 'dafeiyu-pixel', speciesId: 'dafeiyu', outfitId: 'swimsuit' });
  const clipsId = P.chosenPack(packs, { dafeiyu: 'dafeiyu-clips' }, 'dafeiyu');
  assert.equal(clipsId, 'dafeiyu-clips');
  const swim = P.resolveLook(packs, { packId: clipsId, fallbackId: P.fallbackPack('dafeiyu'), speciesId: 'dafeiyu', outfitId: 'swimsuit' });
  assert.ok(swim, 'the clips only show daily: the swimsuit is not left without art');
  assert.equal(swim.packId, 'dafeiyu-pixel');
  assert.equal(swim.kind, 'sprites');
  assert.equal(swim.url, 'pack://dafeiyu-pixel/sheets/swimsuit.webp');
  assert.deepEqual(swim, pixel);
  assert.equal(P.resolveLook(packs, { packId: clipsId, fallbackId: P.fallbackPack('dafeiyu'), speciesId: 'dafeiyu', outfitId: 'daily' }), null, 'daily plays her clips');
  const classic = P.resolveLook(packs, { packId: 'dafeiyu-classic', fallbackId: P.fallbackPack('dafeiyu'), speciesId: 'dafeiyu', outfitId: 'swimsuit' });
  assert.equal(classic.url, swim.url, 'with 旧版像素 it also comes from her default pack');
});

test('a pack with art for some outfits falls back to the character default pack for the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  writePack(root, sprites({ outfits: { scarf: 'a.png' } }), ['a.png']);
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }, { dir: root, source: 'user' }]);
  assert.equal(packs.get('my-pack').source, 'user');
  const args = { packId: 'my-pack', fallbackId: 'grok-pixel', speciesId: 'grok' };
  assert.equal(P.resolveLook(packs, { ...args, outfitId: 'scarf' }).packId, 'my-pack');
  assert.equal(P.resolveLook(packs, { ...args, outfitId: 'daily' }).packId, 'grok-pixel', 'then the character default pack');
  assert.ok(P.packsFor(packs, 'grok').some((x) => x.id === 'my-pack' && x.outfits === 1));
});

test('schema 1 packs keep working: their older action names map onto the states', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const r = P.readPack(writePack(root, sprites({ actions: { idle: { row: 0, col: 0, frames: 2 }, wave: { row: 1, col: 0, frames: 2 }, cheer: { row: 2, col: 0, frames: 2 }, eat: { row: 3, col: 0, frames: 2 } } }), ['a.png']));
  assert.equal(r.ok, true, (r.errors || []).join());
  const has = (n) => !!r.pack.actions[n];
  assert.deepEqual(resolveAction('pat', has), { name: 'wave', exact: true });
  assert.deepEqual(resolveAction('happy', has), { name: 'cheer', exact: true });
  assert.deepEqual(resolveAction('eat_fruit', has), { name: 'eat', exact: true });
  assert.deepEqual(resolveAction('look', has), { name: 'idle', exact: false });
  assert.match(P.readPack(writePack(root, sprites({ id: 'v1-new-name', actions: { idle: { row: 0, col: 0, frames: 1 }, evolve: { row: 0, col: 0, frames: 1 } } }), ['a.png'])).errors.join(), /unknown action/);
});

test('bad packs are refused with reasons, and cannot reach outside their folder or reuse an id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const check = (m, files) => P.readPack(writePack(root, m, files));
  assert.match(check(sprites({ schema: 3 })).errors.join(), /schema/);
  assert.match(check(sprites({ id: 'A B' })).errors.join(), /id must be/);
  assert.match(check(sprites({ id: 'p-species', species: 'cat' }), ['a.png']).errors.join(), /species must be/);
  assert.match(check(sprites({ id: 'p-outfit', outfits: { tuxedo: 'a.png' } }), ['a.png']).errors.join(), /unknown outfit/);
  assert.match(check(sprites({ id: 'p-escape', outfits: { daily: '../../etc/passwd.png' } })).errors.join(), /relative path/);
  assert.match(check(sprites({ id: 'p-missing' })).errors.join(), /a\.png is missing/);
  assert.match(check(sprites({ id: 'p-script', outfits: { daily: 'x.js' } })).errors.join(), /png/);
  assert.match(check(sprites({ id: 'p-action', actions: { idle: { row: 0, col: 0, frames: 2 }, dance: { row: 0, col: 0, frames: 1 } } }), ['a.png']).errors.join(), /unknown action/);
  assert.match(check(sprites({ id: 'p-noidle', actions: { wave: { row: 0, col: 0, frames: 1 } } }), ['a.png']).errors.join(), /actions\.idle is required/);
  assert.match(P.readPack(fs.mkdtempSync(path.join(os.tmpdir(), 'nopack-'))).errors.join(), /pack\.json: missing/);

  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  writePack(r2, sprites({ id: 'grok-pixel' }), ['a.png']);
  const { packs, problems } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }, { dir: r2, source: 'user' }]);
  assert.equal(packs.get('grok-pixel').source, 'builtin', 'a user pack cannot replace a built-in one');
  assert.match(problems[0].errors[0], /already used/);
});

test('a pictures pack needs no frames or actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const r = P.readPack(writePack(root, { schema: 1, id: 'pics', name: 'Pics', species: 'claude', kind: 'pictures', outfits: { daily: 'img/d.webp'.replace('webp', 'png') } }, ['img/d.png']));
  assert.equal(r.ok, true);
  assert.equal(r.pack.frame, null);
  assert.equal(r.pack.author, '未署名');
});

test('every character has an 18+ 成年版 pack: her daily look and the adult outfits drawn so far, listed and worn only with adult content on', () => {
  const { OUTFITS } = require('../src/core/outfits');
  const adultIds = OUTFITS.filter((o) => o.rating === 'adult').map((o) => o.id);
  // 2026-10-31: only the sexy maid outfit is drawn; the other nine were stopped by the image service's safety pause
  const drawn = ['maid', 'sexy_bikini'];
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  for (const id of ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']) {
    const a = packs.get(`${id}-adult`);
    assert.equal(a.species, id);
    assert.equal(a.adult, true, `${a.id} is marked 18+`);
    assert.deepEqual(Object.keys(a.outfits).sort(), ['daily', ...drawn].sort(), 'daily and the drawn adult outfits only');
    for (const o of Object.keys(a.outfits)) assert.ok(o === 'daily' || adultIds.includes(o), `${o} is adult-rated`);
    assert.equal(Object.keys(a.actions).length, 17, 'every state animated, walking included');
    for (const p of [`${id}-pixel`, `${id}-classic`]) assert.ok(!packs.get(p).adult, `${p} is all-ages`);
    for (const o of adultIds) assert.equal(packs.get(`${id}-pixel`).outfits[o], undefined, `no ${o} in her all-ages pack`);
    // hidden and never worn without adult content
    assert.ok(!P.packsFor(packs, id).some((o) => o.id === a.id));
    assert.ok(P.packsFor(packs, id, true).some((o) => o.id === a.id && o.adult));
    assert.equal(P.chosenPack(packs, { [id]: a.id }, id), `${id}-pixel`, 'falls back to her default look');
    assert.equal(P.chosenPack(packs, { [id]: a.id }, id, true), a.id);
  }
});

// 全动态 rig packs: a model.json of layers and the skeleton they hang from, every outfit a folder of layers
test('rig packs: the model is checked and goes to the renderer with the look; other outfits fall back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-'));
  const model = {
    size: [100, 200],
    parts: [{ id: 'body', deformer: 'skirt', z: 1, box: [10, 50, 80, 150], grid: [4, 8] }, { id: 'head', deformer: 'head', z: 2, box: [20, 0, 60, 60] }],
    pivots: { body: [50, 200], head: [50, 60] },
    legs: { hem: 170, feet: 200, split: 50 },
    face: { box: [30, 20, 40, 30], eyes: [[35, 25, 45, 32], [55, 25, 65, 32]], mouth: [50, 42] },
  };
  const rig = (over = {}) => ({ schema: 2, id: 'my-rig', name: 'Live', species: 'grok', kind: 'rig', model: 'model.json', outfits: { daily: 'daily/preview.png' }, ...over });
  const dir = writePack(root, rig(), ['daily/preview.png', 'daily/body.png', 'daily/head.png']);
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model));
  const r = P.readPack(dir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.pack.model.parts.map((p) => [p.id, p.deformer, p.grid]), [['body', 'skirt', [4, 8]], ['head', 'head', [4, 4]]]);
  const packs = new Map([[r.pack.id, r.pack], ...P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]).packs]);
  const look = P.resolveLook(packs, { packId: 'my-rig', speciesId: 'grok', outfitId: 'daily' });
  assert.equal(look.kind, 'rig');
  assert.equal(look.base, 'pack://my-rig/daily', 'the layers are read next to the preview');
  assert.equal(look.url, 'pack://my-rig/daily/preview.png');
  assert.deepEqual(look.model.face.mouth, [50, 42]);
  assert.equal(P.resolveLook(packs, { packId: 'my-rig', speciesId: 'grok', outfitId: 'beret' }).packId, 'grok-pixel', 'an outfit without layers wears the default pack');

  // a missing layer, an unknown deformer, a reserved part id, a model outside the pack
  fs.rmSync(path.join(dir, 'daily', 'head.png'));
  assert.match(P.readPack(dir).errors.join(), /outfit daily has no layer daily\/head\.png/);
  fs.writeFileSync(path.join(dir, 'daily', 'head.png'), PNG);
  const bad = (m) => { fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(m)); return P.readPack(dir).errors.join(); };
  assert.match(bad({ ...model, parts: [{ ...model.parts[0], deformer: 'wings' }] }), /deformer must be one of/);
  assert.match(bad({ ...model, parts: [{ ...model.parts[0], id: 'face' }] }), /reserved/);
  assert.match(bad({ ...model, face: { box: [0, 0, 1, 1] } }), /face must be/);
  assert.match(bad({ ...model, size: [0, 10] }), /size/);
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(rig({ model: '../model.json' })));
  assert.match(P.readPack(dir).errors.join(), /model: must be a relative path/);
});

test('大肥鱼 · 全动态: every layer of the built-in rig is in the model, with her face and skeleton', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  const live = packs.get('dafeiyu-live');
  assert.equal(live.kind, 'rig');
  assert.deepEqual(live.model.parts.map((p) => p.id).sort(), ['ahoge', 'body', 'fin_l', 'fin_r', 'hair', 'head', 'tail']);
  assert.ok(live.model.face && live.model.legs && live.model.pivots.head, 'eyes and mouth, legs, the neck');
  assert.equal(P.chosenPack(packs, {}, 'dafeiyu'), 'dafeiyu-pixel', 'the pixels stay her default');
});

// Live2D packs: a Cubism 4 model in the pack and the map from the app's moves onto its parameters
test('live2d packs: the model and its files are checked, the parameter map goes to the renderer with the look', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-'));
  const l2d = (over = {}) => ({ schema: 2, id: 'my-l2d', name: 'L2D', species: 'grok', kind: 'live2d', model: 'm/a.model3.json', live2d: { height: 0.75, params: { armL: 'ParamArmL', tail: 'ParamTail', armOut: -20 }, faces: { blush: { ParamCheek: 1 } }, pinned: { ParamWatermark: 1 } }, outfits: { daily: 'preview.png' }, ...over });
  const dir = writePack(root, l2d(), ['preview.png', 'm/tex/t0.png']);
  fs.writeFileSync(path.join(dir, 'm', 'a.moc3'), 'moc');
  fs.writeFileSync(path.join(dir, 'm', 'a.physics3.json'), '{}');
  fs.writeFileSync(path.join(dir, 'm', 'a.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: ['tex/t0.png'], Physics: 'a.physics3.json' } }));
  const r = P.readPack(dir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.pack.live2d, { height: 0.75, params: { armL: 'ParamArmL', tail: 'ParamTail', armOut: -20 }, faces: { blush: { ParamCheek: 1 } }, pinned: { ParamWatermark: 1 } });
  const packs = new Map([[r.pack.id, r.pack], ...P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]).packs]);
  const look = P.resolveLook(packs, { packId: 'my-l2d', speciesId: 'grok', outfitId: 'daily' });
  assert.equal(look.kind, 'live2d');
  assert.equal(look.model, 'pack://my-l2d/m/a.model3.json');
  assert.equal(look.url, 'pack://my-l2d/preview.png', 'the picture for lists and the wardrobe');
  assert.equal(look.live2d.params.tail, 'ParamTail');
  assert.equal(P.resolveLook(packs, { packId: 'my-l2d', speciesId: 'grok', outfitId: 'beret' }).packId, 'grok-pixel', 'other outfits wear the default pack');

  const errs = (over) => { fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(l2d(over))); return P.readPack(dir).errors.join(); };
  assert.match(errs({ model: '../a.model3.json' }), /relative path to a \.model3\.json/);
  assert.match(errs({ live2d: { params: { wings: 'ParamWings' } } }), /live2d\.params\.wings/);
  assert.match(errs({ live2d: { faces: { blush: { 'bad id': 1 } } } }), /live2d\.faces\.blush/);
  assert.match(errs({ live2d: { height: 3 } }), /live2d\.height/);
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(l2d()));
  fs.rmSync(path.join(dir, 'm', 'a.moc3'));
  assert.match(P.readPack(dir).errors.join(), /a\.moc3 is missing/);
  fs.writeFileSync(path.join(dir, 'm', 'a.model3.json'), JSON.stringify({ FileReferences: { Moc: '../../outside.moc3', Textures: ['tex/t0.png'] } }));
  assert.match(P.readPack(dir).errors.join(), /outside\.moc3 is missing/, 'a file outside the pack does not count');
});

test('大肥鱼 · Live2D: the built-in model is complete, its watermark and chest physics are pinned, pixels stay her default', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  const p = packs.get('dafeiyu-live2d');
  assert.equal(p.kind, 'live2d');
  assert.equal(p.live2d.pinned.Paramcol_3, 1, 'the model\'s own watermark switch is off');
  for (const id of ['ParamYFWL_21', 'ParamYFWL_22', 'ParamYFWL_23', 'ParamYFWL_24']) assert.equal(p.live2d.pinned[id], 0, `${id}: no chest physics (all-ages)`);
  assert.ok(p.live2d.faces.blush && p.live2d.faces.wide && p.live2d.params.tail);
  assert.match(p.author, /Mao绒绒家园/);
  assert.equal(P.chosenPack(packs, {}, 'dafeiyu'), 'dafeiyu-pixel');
  for (const f of ['live2dcubismcore.min.js', 'pixi.min.js', 'unsafe-eval.min.js', 'cubism4.min.js']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'live2d', f)), `runtime ${f}`);
});
