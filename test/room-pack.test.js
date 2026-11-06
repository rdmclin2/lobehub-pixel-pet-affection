'use strict';
// 像素房间 · 游戏包校验 (src/core/room-pack.js through src/core/game-pack.js; docs/her-room-design.md §1). The pack
// is the minimal fixture test/fixtures/games/pixel-room (scripts/build-room-fixture.js): one open room and four
// 即将开放 ones. Each broken variant is one error that names what is wrong; the yard packs keep their own rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const GP = require('../src/core/game-pack');
const GS = require('../src/core/game-store');
const Room = require('../src/core/room-pack');
const { zip, sha256 } = require('../scripts/build-character-catalog');

const SRC = path.join(__dirname, 'fixtures', 'games', 'pixel-room');
const read = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const M = () => read('manifest.json');
const FILES = fs.readdirSync(SRC);
const SPR = { 'dafeiyu-sprites.json': read('dafeiyu-sprites.json') };
const check = (m, opts = {}) => GP.validateManifest(m, { files: FILES, sprites: SPR, ...opts });
const edit = (fn) => { const m = M(); fn(m, m.themes[0]); return m; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-room-'));

test('the fixture room pack is good: room@1 is an engine this app plays; the folder holds only the files it names', () => {
  assert.ok(GP.ENGINES.includes('room@1'));
  assert.deepEqual(check(M()), []);
  assert.equal(GS.checkFolder(SRC, 'pixel-room'), null);
  assert.deepEqual(GP.namedFiles(M()).sort(), ['dafeiyu-atlas.png', 'dafeiyu-room.png', 'dafeiyu-sprites.json']);
  assert.deepEqual(GP.spriteFiles(M()), ['dafeiyu-sprites.json']);
  // the fixture on disk is what the script writes
  const { build } = require('../scripts/build-room-fixture');
  for (const [n, b] of Object.entries(build())) assert.ok(fs.readFileSync(path.join(SRC, n)).equals(b), `${n} is stale: node scripts/build-room-fixture.js`);
});

test('validateRoom: one error per broken thing', () => {
  const cases = [
    ['a missing activity', edit((m, t) => { delete t.activities.music; }), /activities.music is missing/],
    ['`at` names no furniture', edit((m, t) => { t.activities.work.at = 'sofa'; }), /"sofa" is not a piece of furniture/],
    ['a spot off the floor', edit((m, t) => { t.activities.phone.spot = [400, 200]; }), /phone.spot must be \[x, y\] on the floor/],
    ['an unknown fx', edit((m, t) => { t.activities.game.props.push({ fx: 'script', src: 'x.js' }); }), /fx "script" is not one the engine draws/],
    ['an fx parameter out of range', edit((m, t) => { t.activities.sleep.props[0].to = 0.05; }), /dim\): to must be 0.3–1/],
    ['a hand out of 0–1', edit((m, t) => { t.activities.phone.props[1].hand = [1.4, 0.5]; }), /hand must be \[u, v\] in 0–1/],
    ['an fx sprite missing', edit((m, t) => { t.activities.music.props[0].sprite = 'nope'; }), /no sprite "nope"/],
    ['deltas over ±40', edit((m) => { m.activities.sleep.deltas.energy = 80; }), /deltas.energy must be −40 to 40/],
    ['a delta key it does not know', edit((m) => { m.activities.game.deltas.affection = 5; }), /deltas.affection: only energy/],
    ['seconds out of range', edit((m) => { m.activities.work.seconds = 3; }), /work.seconds must be 5–600/],
    ['a lying scale out of range', edit((m, t) => { t.activities.sleep.lieScale = 2; }), /lieScale/],
    ['smooth that is not a boolean', edit((m, t) => { t.smooth = 'yes'; }), /smooth/],
    ['lying down with no place to lie (she would lie on the floor)', edit((m, t) => { delete t.activities.sleep.lie; }), /pose "tucked" needs lie/],
    ['a room changing the numbers', edit((m, t) => { t.activities.work.deltas = { focus: 40 }; }), /a room cannot change the numbers/],
    ['a file not named after its room', edit((m, t) => { t.images.atlas = 'atlas.png'; }), /must start with "dafeiyu-"/],
    ['a file that is not there', edit((m, t) => { t.images.room = 'dafeiyu-room2.png'; }), /dafeiyu-room2.png is missing/],
    ['a code file', edit((m, t) => { t.images.room = 'dafeiyu-room.js'; }), /not allowed/],
    ['a character that is not a default one', edit((m) => { m.themes[1].character = 'kitty'; }), /character "kitty"/],
    ['no open room', edit((m) => { m.themes[0].status = 'soon'; }), /at least one theme must be open/],
    ['defaultTheme not open', edit((m) => { m.defaultTheme = 'claude'; }), /defaultTheme "claude"/],
    ['a palette colour', edit((m) => { m.themes[2].palette.trim = 'gold'; }), /palette.trim must be #RRGGBB/],
    ['a quest on an unknown kind', edit((m) => { m.quests[0].on.kind = 'dance'; }), /on.kind is not one of/],
    ['a quest in an unknown room', edit((m) => { m.quests[0].on.theme = 'mars'; }), /on.theme is not a theme here/],
    ['an anim she has not', edit((m) => { m.activities.music.anim = 'fly'; }), /anim "fly"/],
  ];
  for (const [what, m, re] of cases) {
    const e = check(m);
    assert.ok(e.length >= 1, `${what}: no error`);
    assert.match(e.join('\n'), re, `${what}: ${e.join(' | ')}`);
  }
});

test('validateRoom: a 即将开放 room needs only its card fields; an open one needs everything; size and count limits', () => {
  const soon = M().themes[1];
  assert.deepEqual(Object.keys(soon).sort(), ['blurb', 'character', 'id', 'motifs', 'name', 'palette', 'status']);
  // turning claude open without its room is refused, naming what is missing
  const m = edit((x) => { x.themes[1].status = 'open'; });
  assert.match(check(m).join('\n'), /themes\[1\] \(claude\)\.world/);
  // a preview picture may be named for a soon room, and has to be there
  assert.match(check(edit((x) => { x.themes[1].preview = 'claude-preview.webp'; })).join(), /claude-preview.webp is missing/);
  assert.deepEqual(check(edit((x) => { x.themes[1].preview = 'claude-preview.webp'; }), { files: [...FILES, 'claude-preview.webp'] }), []);
  // limits
  const big = edit((x) => { x.description = 'x'.repeat(260 * 1024); });
  assert.match(check(big).join(), /at most 262144/);
  const many = edit((x) => { for (let i = 0; i < 12; i++) x.themes.push({ ...x.themes[1], id: `extra-${i}` }); });
  assert.match(check(many).join(), /at most 12 themes/);
  // the default characters are the ones in src/characters
  const ids = fs.readdirSync(path.join(__dirname, '..', 'src', 'characters')).map((f) => f.replace(/\.json$/, '')).sort();
  assert.deepEqual([...Room.DEFAULT_CHARACTERS].sort(), ids);
});

test('the yard packs keep their rules (yard@1 still validated as before)', () => {
  const yard = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'mini-yard', 'manifest.json'), 'utf8'));
  assert.deepEqual(GP.validateManifest(yard), []);
  assert.match(GP.validateManifest({ ...yard, images: {} }).join(), /images.terrain is missing/);
  // a yard manifest is not checked with the room's rules, nor the other way round
  assert.match(GP.validateManifest({ ...M(), engine: 'yard@1' }).join(), /images.terrain is missing/);
  assert.match(GP.validateManifest({ ...yard, engine: 'room@1' }).join(), /themes must be a list/);
});

test('installArchive: a flat room pack with prefixed files installs; a folder inside it or a stray file is refused', async () => {
  const root = tmp();
  const z = path.join(tmp(), 'pixel-room.zip');
  zip(SRC, z);
  const entry = { id: 'pixel-room', version: M().version, sha256: sha256(z), bytes: fs.statSync(z).size };
  assert.deepEqual(await GS.installArchive(root, entry, z), { ok: true, id: 'pixel-room' });
  assert.deepEqual(GS.listInstalled([{ dir: root, source: 'download' }]).map((g) => [g.id, g.version]), [['pixel-room', M().version]]);
  // progress is outside the game folder: an update keeps it
  GS.writeProgress(root, 'pixel-room', { state: { theme: 'dafeiyu', focus: { dafeiyu: 77 } } });
  const z2 = path.join(tmp(), 'pixel-room-2.zip');
  const w = tmp();
  for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(w, f));
  fs.writeFileSync(path.join(w, 'manifest.json'), JSON.stringify({ ...M(), version: '0.2.0' }));
  zip(w, z2);
  assert.deepEqual(await GS.installArchive(root, { ...entry, version: '0.2.0', sha256: sha256(z2), bytes: fs.statSync(z2).size }, z2), { ok: true, id: 'pixel-room' });
  assert.equal(GS.readProgress(root, 'pixel-room').state.focus.dafeiyu, 77);
  // a subfolder
  const bad = tmp();
  for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(bad, f));
  fs.mkdirSync(path.join(bad, 'dafeiyu'));
  fs.writeFileSync(path.join(bad, 'dafeiyu', 'x.png'), 'x');
  assert.equal(GS.checkFolder(bad, 'pixel-room').reason, 'stray-file');
  fs.rmSync(path.join(bad, 'dafeiyu'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'run.js'), 'x');
  assert.equal(GS.checkFolder(bad, 'pixel-room').reason, 'stray-file');
});

test('game-index: a room@1 entry needs an app that has the engine, and a new enough one', () => {
  const GI = require('../src/core/game-index');
  const e = { id: 'pixel-room', engine: 'room@1', minAppVersion: '0.27.0' };
  assert.deepEqual(GI.supported(e, { engines: ['yard@1'], appVersion: '0.30.0' }), { ok: false, reason: 'engine' });
  assert.deepEqual(GI.supported(e, { engines: GP.ENGINES, appVersion: '0.26.0' }), { ok: false, reason: 'app' });
  assert.deepEqual(GI.supported(e, { engines: GP.ENGINES, appVersion: '0.27.0' }), { ok: true });
  const index = { games: [{ ...e, name: '像素房间', version: '1.0.0', bytes: 1, screenshots: [], features: [] }] };
  assert.equal(GI.storeRows(index, new Map(), [], { engines: ['yard@1'], appVersion: '0.27.0' })[0].stateLabel, '需要更新应用');
});
