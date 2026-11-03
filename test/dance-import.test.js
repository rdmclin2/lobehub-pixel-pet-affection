'use strict';
// 导入舞蹈 / 删除舞蹈 (docs/vrm-dance.md §5.5, T-2801): what is picked → a draft (core/vrm-dances.js detectDance,
// src/main/dance-import.js inspect), the bake and the atomic write into the library, plain-words failures, removal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/core/vrm-dances');
const I = require('../src/main/dance-import');
const VMD = require('../src/core/vmd');
const { testVmd, beepWav, coverPng } = require('../scripts/make-test-dance');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dance-import-'));
const cameraVmd = () => VMD.writeVmd({ modelName: 'cam', bones: [], cameras: [{ frame: 0, distance: -45, pos: [0, 10, 0], rot: [0, 0, 0], fov: 30 }] });

test('detectDance: a vidol pack follows meta.json; an MMD folder takes the dancer with the most keys; music and cover by name', () => {
  const pack = D.detectDance({
    folder: 'vidol-dance-x', meta: { name: '開心搖', type: 'anim', src: './a.vmd', audio: './song.mp3' },
    files: [{ path: '/p/a.vmd', size: 10 }, { path: '/p/song.mp3', size: 5 }, { path: '/p/big.mp3', size: 50 }, { path: '/p/thumb.jpg', size: 1 }, { path: '/p/cover.jpg', size: 2 }, { path: '/p/readme.txt', size: 1 }],
    motions: [{ path: '/p/a.vmd', kind: 'motion', keys: 100 }],
  });
  assert.equal(pack.ok, true);
  assert.equal(pack.source, 'vidol-pack');
  assert.equal(pack.name, '開心搖');
  assert.equal(pack.audio, '/p/song.mp3');
  assert.equal(pack.cover, '/p/cover.jpg');
  assert.equal(pack.readme, '/p/readme.txt');
  const mmd = D.detectDance({
    folder: 'lupin',
    files: [{ path: '/m/Camera.vmd', size: 1 }, { path: '/m/long.vmd', size: 3 }, { path: '/m/short.vmd', size: 2 }, { path: '/m/Chair.vmd', size: 1 }, { path: '/m/short.wav', size: 9 }, { path: '/m/x.mp3', size: 99 }, { path: '/m/EmbeddedCover.png', size: 1 }],
    motions: [{ path: '/m/Camera.vmd', kind: 'camera', keys: 0 }, { path: '/m/long.vmd', kind: 'motion', keys: 300 }, { path: '/m/short.vmd', kind: 'motion', keys: 100 }, { path: '/m/Chair.vmd', kind: 'prop', keys: 2 }],
  });
  assert.equal(mmd.ok, true);
  assert.equal(mmd.source, 'mmd-folder');
  assert.equal(mmd.motion, '/m/long.vmd');
  assert.deepEqual(mmd.others, ['/m/short.vmd']); // camera and prop motions are not offered
  assert.equal(mmd.audio, '/m/x.mp3'); // none named like long.vmd: the largest
  assert.equal(mmd.cover, '/m/EmbeddedCover.png');
  assert.ok(mmd.warnings.some((w) => /还有 1 个舞蹈动作/.test(w)));
});

test('detectDance: failures say what happened and what to do', () => {
  const r = (listing) => D.detectDance(listing);
  assert.equal(r({ files: [] }).reason, 'no-files');
  assert.equal(r({ files: [{ path: '/a.mp3', size: 1 }], motions: [] }).reason, 'no-motion');
  const cam = r({ files: [{ path: '/c.vmd', size: 1 }], motions: [{ path: '/c.vmd', kind: 'camera', keys: 0 }] });
  assert.equal(cam.reason, 'only-camera');
  assert.match(cam.message, /镜头或道具/);
  assert.equal(r({ files: [{ path: '/b.vmd', size: 1 }], motions: [{ path: '/b.vmd', kind: 'bad', keys: 0 }] }).reason, 'bad-vmd');
  assert.equal(r({ meta: { type: 'vrm' }, files: [{ path: '/b.vmd', size: 1 }], motions: [] }).reason, 'not-anim');
  const ncm = r({ files: [{ path: '/d.vmd', size: 1 }, { path: '/d.ncm', size: 1 }], motions: [{ path: '/d.vmd', kind: 'motion', keys: 9 }] });
  assert.equal(ncm.ok, true);
  assert.equal(ncm.audio, null);
  assert.ok(ncm.warnings.some((w) => /加密格式/.test(w)));
  for (const [k, m] of Object.entries(D.IMPORT_ERRORS)) assert.ok(m.length > 4 && !/VMD 解析|undefined/.test(m), k);
});

test('creditOf / danceId', () => {
  assert.equal(D.creditOf('使用此动作数据时，请注明动作作者：妮谷丹\r\n'), '动作作者：妮谷丹');
  assert.equal(D.creditOf('Motion by yurie\nthanks'), 'Motion by yurie');
  assert.equal(D.creditOf('nothing here'), null);
  assert.match(D.danceId('Gokuraku Jodo', () => 0.5), /^gokuraku-jodo-8000$/);
  assert.match(D.danceId('極楽浄土', () => 0), /^dance-0000$/);
  assert.ok(D.ID_RE.test(D.danceId('x'.repeat(80))));
});

test('inspect → commit: baked into <dir>/<id>/, library.json updated atomically, the entry passes cleanDanceIndex; remove deletes it', async () => {
  const src = tmp();
  const lib = tmp();
  fs.writeFileSync(path.join(src, 'Motion.vmd'), testVmd());
  fs.writeFileSync(path.join(src, 'Camera.vmd'), cameraVmd());
  fs.writeFileSync(path.join(src, 'Motion.wav'), beepWav(6));
  fs.writeFileSync(path.join(src, 'cover.png'), coverPng());
  fs.writeFileSync(path.join(src, 'readme.txt'), 'Motion by e2e\n');
  const d = I.inspect([src]);
  assert.equal(d.ok, true, d.message);
  assert.equal(d.name, path.basename(src));
  assert.equal(d.motion, path.join(src, 'Motion.vmd'));
  assert.equal(d.motions.length, 1);
  assert.ok(Math.abs(d.duration - 6) < 0.1, `duration ${d.duration}`);
  assert.equal(d.audio, path.join(src, 'Motion.wav'));
  assert.match(d.coverData, /^data:image\/png;base64,/);
  assert.equal(d.credit, 'Motion by e2e');
  // files picked one by one work the same
  const files = I.inspect([path.join(src, 'Motion.vmd'), path.join(src, 'cover.png')]);
  assert.equal(files.ok, true);
  assert.equal(files.audio, null);
  // another music file must be a supported one
  fs.writeFileSync(path.join(src, 'song.ncm'), 'x');
  assert.equal(I.addExtra(d.token, 'audio', path.join(src, 'song.ncm')).reason, 'encrypted-audio');
  assert.equal(I.addExtra(d.token, 'cover', path.join(src, 'Motion.wav')).reason, 'bad-cover');
  assert.equal(I.addExtra('nope', 'audio', path.join(src, 'Motion.wav')).reason, 'expired');

  const r = await I.commit({ token: d.token, name: '  测试舞 Test  ', motion: d.motion, audio: d.audio, cover: d.cover }, lib);
  assert.equal(r.ok, true, r.message);
  assert.match(r.id, /^test-[0-9a-f]{4}$/);
  assert.equal(r.name, '测试舞 Test');
  assert.deepEqual(r.dance, { id: r.id, name: '测试舞 Test', duration: r.dance.duration, music: true, cover: true, loop: false, face: true, builtin: false, credit: 'Motion by e2e' });
  const files2 = fs.readdirSync(path.join(lib, r.id)).sort();
  assert.deepEqual(files2, ['audio.wav', 'cover.png', 'dance.vrma', 'readme.txt', 'src']);
  assert.deepEqual(fs.readdirSync(path.join(lib, r.id, 'src')), ['Motion.vmd']);
  assert.ok(!fs.readdirSync(lib).some((f) => /\.tmp$/.test(f)), 'no temporary leftovers');
  const index = D.cleanDanceIndex(JSON.parse(fs.readFileSync(path.join(lib, 'library.json'), 'utf8')));
  assert.equal(index.dances[r.id].file, `${r.id}/dance.vrma`);
  assert.equal(index.dances[r.id].source, 'mmd-folder');
  // a token is used once
  assert.equal((await I.commit({ token: d.token, motion: d.motion }, lib)).reason, 'expired');

  assert.equal(I.remove(lib, 'demo').reason, 'builtin');
  assert.equal(I.remove(lib, '../x').reason, 'not-found');
  const rm = I.remove(lib, r.id);
  assert.equal(rm.ok, true);
  assert.equal(fs.existsSync(path.join(lib, r.id)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lib, 'library.json'), 'utf8')).dances, {});
  assert.equal(I.remove(lib, r.id).reason, 'not-found');
});

test('inspect: a folder with only a camera motion, a broken VMD, nothing usable → the reason in plain words', () => {
  const a = tmp();
  fs.writeFileSync(path.join(a, 'Camera.vmd'), cameraVmd());
  assert.equal(I.inspect([a]).reason, 'only-camera');
  const b = tmp();
  fs.writeFileSync(path.join(b, 'broken.vmd'), Buffer.from('not a vmd at all, just text'));
  assert.equal(I.inspect([b]).reason, 'bad-vmd');
  assert.equal(I.inspect([tmp()]).reason, 'no-files');
  assert.equal(I.inspect([path.join(os.tmpdir(), 'no-such-dance-folder-x')]).reason, 'no-files');
});

test('commit refuses a library inside the repository', async () => {
  const r = await I.commit({ token: 'x' }, path.join(__dirname, '..', 'tmp-dances'));
  assert.equal(r.reason, 'no-library');
});
