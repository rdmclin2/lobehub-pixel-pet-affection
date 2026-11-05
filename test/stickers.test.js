'use strict';

// 表情包集合 (src/core/stickers.js, docs/stickers-design.md §2): add several pictures to a character's own set,
// delete one, read them back from a fresh library (a restart), refuse what is not a sticker; built-in memes
// stay a read-only set and [梗图:id] can pick the owner's pictures too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const S = require('../src/core/stickers');
const memes = require('../src/core/memes');
const persona = require('../src/core/persona');
const { getSpecies } = require('../src/core/species');

const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, [r, g, b] = [255, 0, 0]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const gif = (w, h, frames = 1) => {
  const head = Buffer.from('GIF89a'); const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2);
  const gce = Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]);
  return Buffer.concat([head, lsd, ...Array.from({ length: frames }, () => gce), Buffer.from([0x3b])]);
};
const webpX = (w, h, animated) => {
  const b = Buffer.alloc(30); b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUInt32LE(10, 16);
  b[20] = animated ? 0x02 : 0; b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b;
};
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-test-'));
const sp = getSpecies('dafeiyu');

test('imageInfo reads the size of PNG, GIF, WebP and JPEG by content', () => {
  assert.deepEqual(S.imageInfo(png(120, 90)), { mime: 'image/png', width: 120, height: 90, animated: false });
  assert.deepEqual(S.imageInfo(gif(200, 100, 3)), { mime: 'image/gif', width: 200, height: 100, animated: true });
  assert.equal(S.imageInfo(gif(200, 100, 1)).animated, false);
  assert.deepEqual(S.imageInfo(webpX(256, 128, true)), { mime: 'image/webp', width: 256, height: 128, animated: true });
  assert.deepEqual(S.imageInfo(jpeg(300, 200)), { mime: 'image/jpeg', width: 300, height: 200, animated: false });
  assert.equal(S.imageInfo(Buffer.from('definitely not a picture, only text')), null);
});

test('several pictures are added to her own set in order, each one stored once under userData', () => {
  const dir = tmp();
  const lib = new S.StickerLibrary(dir, { now: () => 1000 });
  const r = lib.add(sp, [{ name: '超开心.png', buffer: png(128, 128, [255, 0, 0]) }, { name: 'cry_face.png', buffer: png(96, 96, [0, 255, 0]) }, { name: 'wow.gif', buffer: gif(160, 160, 2) }]);
  assert.equal(r.ok, true);
  assert.equal(r.added.length, 3);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.count, 3);
  assert.deepEqual(r.added.map((s) => s.label), ['超开心', 'cry face', 'wow']);
  assert.ok(r.added.every((s) => S.ID_RE.test(s.id) && /^sticker:\/\/blob\/[0-9a-f]{64}\.(png|gif)$/.test(s.url)));
  assert.equal(r.added[2].animated, true);
  assert.equal(new Set(r.added.map((s) => s.id)).size, 3);
  assert.equal(fs.readdirSync(path.join(dir, 'blobs')).length, 3);
  assert.ok(fs.existsSync(path.join(dir, 'sets', 'mine-dafeiyu.json')));
  // the same picture twice is refused, not stored again
  const again = lib.add(sp, [{ name: 'copy.png', buffer: png(128, 128, [255, 0, 0]) }]);
  assert.equal(again.ok, false);
  assert.equal(again.rejected[0].reason, 'duplicate');
  assert.equal(fs.readdirSync(path.join(dir, 'blobs')).length, 3);
});

test('list: the built-in memes come first and read-only, then her own set', () => {
  const lib = new S.StickerLibrary(tmp());
  lib.add(sp, [{ name: 'a.png', buffer: png(64, 64) }]);
  const l = lib.list(sp);
  assert.equal(l.ok, true);
  assert.deepEqual(l.sets.map((s) => [s.id, s.kind, s.readOnly]), [['builtin:dafeiyu', 'builtin', true], ['mine-dafeiyu', 'mine', false]]);
  assert.equal(l.sets[0].stickers.length, sp.memes.length);
  assert.equal(l.sets[0].stickers[0].url, `sticker://builtin/dafeiyu/${sp.memes[0].id}.webp`);
  assert.equal(l.sets[1].stickers.length, 1);
  // a character with no stickers yet: an empty set of her own
  const g = lib.list(getSpecies('claude'));
  assert.equal(g.sets.find((s) => s.kind === 'mine').stickers.length, 0);
});

test('delete one, then a new library over the same folder (a restart) reads the rest back', () => {
  const dir = tmp();
  const lib = new S.StickerLibrary(dir);
  const r = lib.add(sp, [1, 2, 3, 4].map((i) => ({ name: `p${i}.png`, buffer: png(64 + i, 64 + i) })));
  assert.equal(r.added.length, 4);
  const del = lib.remove(sp, [r.added[1].id]);
  assert.deepEqual(del, { ok: true, removed: 1, count: 3 });
  assert.equal(lib.remove(sp, [r.added[1].id]).reason, 'not-found');
  const after = new S.StickerLibrary(dir).list(sp).sets.find((s) => s.kind === 'mine');
  assert.deepEqual(after.stickers.map((s) => s.label), ['p1', 'p3', 'p4']);
  // new ids never reuse a deleted one (an old [梗图:id] in a chat never names another picture)
  const more = new S.StickerLibrary(dir).add(sp, [{ name: 'p5.png', buffer: png(80, 80) }]);
  assert.ok(!r.added.map((s) => s.id).includes(more.added[0].id));
  // the deleted picture's blob stays until gc, which keeps what 聊天记录 still names
  assert.equal(fs.readdirSync(path.join(dir, 'blobs')).length, 5);
  const keep = r.added[1].blob;
  assert.deepEqual(lib.gc([keep]), []);
  assert.deepEqual(lib.gc([]), [keep]);
  assert.equal(fs.readdirSync(path.join(dir, 'blobs')).length, 4);
});

test('what is not a sticker is refused with a reason, the rest of the batch still goes in', () => {
  const dir = tmp();
  const lib = new S.StickerLibrary(dir);
  const big = Buffer.concat([png(200, 200), Buffer.alloc(S.MAX_STICKER_BYTES)]);
  const r = lib.add(sp, [
    { name: 'notes.png', buffer: Buffer.from('this is a text file renamed to .png') },
    { name: 'huge.png', buffer: big },
    { name: 'tiny.png', buffer: png(32, 32) },
    { name: 'giant.png', buffer: png(1500, 1500) },
    { name: 'strip.png', buffer: png(500, 64) },
    { name: 'gone.png', error: { reason: 'not-found', message: '找不到这个文件' } },
    { name: 'ok.png', buffer: png(100, 100) },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.added.map((s) => s.label), ['ok']);
  assert.deepEqual(r.rejected.map((x) => [x.name, x.reason]), [['notes.png', 'bad-type'], ['huge.png', 'too-large'], ['tiny.png', 'too-small'], ['giant.png', 'too-big'], ['strip.png', 'bad-ratio'], ['gone.png', 'not-found']]);
  assert.ok(r.rejected.every((x) => x.message));
  assert.equal(fs.readdirSync(path.join(dir, 'blobs')).length, 1);
  // only bad files: nothing written
  const none = lib.add(getSpecies('claude'), [{ name: 'x.txt', buffer: Buffer.from('hello world, not an image') }]);
  assert.equal(none.ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'sets', 'mine-claude.json')), false);
});

test('a corrupt set file reads as empty instead of breaking her page; bad names never reach the disk', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sets', 'mine-dafeiyu.json'), '{not json');
  const lib = new S.StickerLibrary(dir);
  assert.equal(lib.list(sp).sets.find((s) => s.kind === 'mine').stickers.length, 0);
  assert.equal(lib.blobPath('../../etc/passwd'), null);
  assert.equal(lib.blobPath(`${'a'.repeat(64)}.png`), null); // well-formed but not stored
  assert.equal(lib.list({ id: '../x', memes: [] }).ok, false);
});

test('update renames a sticker and sets when she uses it', () => {
  const lib = new S.StickerLibrary(tmp());
  const { added } = lib.add(sp, [{ name: 'a.png', buffer: png(64, 64) }]);
  const u = lib.update(sp, added[0].id, { label: '  比心  ', desc: '被夸的时候' });
  assert.equal(u.sticker.label, '比心');
  assert.equal(u.sticker.desc, '被夸的时候');
  assert.equal(lib.update(sp, added[0].id, { label: ' ' }).reason, 'bad-label');
});

test('[梗图:id]: built-in memes keep working and her owner\'s stickers can be picked too', () => {
  const lib = new S.StickerLibrary(tmp());
  const { added } = lib.add(sp, [{ name: '比心.png', buffer: png(64, 64), desc: '被夸的时候' }]);
  const cat = lib.catalog(sp);
  assert.equal(cat.length, sp.memes.length + 1);
  const list = { id: sp.id, memes: cat };
  // the hint lists both
  const hint = memes.memeHint(list);
  assert.match(hint, new RegExp(`${sp.memes[0].id}（`));
  assert.match(hint, new RegExp(`${added[0].id}（比心：被夸的时候）`));
  // an old built-in tag still resolves, a new user one too, with its sticker:// picture
  assert.equal(memes.extractMeme(`好呀\n[梗图:${sp.memes[0].id}]`, list).meme, sp.memes[0].id);
  const ex = memes.extractMeme(`谢谢夸奖\n[梗图:${added[0].id}]`, list);
  assert.equal(ex.text, '谢谢夸奖');
  assert.equal(ex.meme, added[0].id);
  assert.match(cat.find((m) => m.id === ex.meme).url, /^sticker:\/\/blob\//);
  assert.equal(cat.find((m) => m.id === sp.memes[0].id).url, `assets/memes/dafeiyu/${sp.memes[0].id}.webp`);
  // persona's state block lists the owner's sticker when given the catalog
  const pet = { speciesId: 'dafeiyu', lastInteractionAt: 0, hunger: 0, mood: 80, energy: 80, affection: 10, name: '鱼' };
  const block = persona.buildStateBlock(pet, Date.now(), { prefs: { memes: true }, memeList: () => list });
  assert.match(block, /比心：被夸的时候/);
});

test('pet service: her reply tagging an owner\'s sticker shows it in the bubble, and the prompt offered it', async () => {
  const { LhClient, cleanEnv } = require('../src/core/lh-client');
  const { Store } = require('../src/core/store');
  const { PetService } = require('../src/main/pet-service');
  const dir = tmp();
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const lib = new S.StickerLibrary(path.join(dir, 'stickers'));
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), stickers: lib, now: () => new Date('2026-01-05T14:00:00').getTime(), rnd: () => 0.5 });
  svc.on('error', () => {});
  const said = [];
  svc.on('say', (m) => said.push(m));
  await svc.hatch({ speciesId: 'dafeiyu', name: '鱼' });
  const { added } = lib.add(getSpecies('dafeiyu'), [{ name: '比心.png', buffer: png(64, 64), desc: '被夸的时候' }]);
  // the fake lh answers `echo: <the prompt's last line>`: the tag comes back as her reply
  await svc.chat(`[梗图:${added[0].id}]`);
  const last = said.at(-1);
  assert.ok(last.meme, 'the bubble carries a sticker');
  assert.equal(last.meme.id, added[0].id);
  assert.equal(last.meme.url, added[0].url);
  assert.doesNotMatch(last.text, /梗图/);
  // a built-in one still works as before
  const builtin = getSpecies('dafeiyu').memes[0];
  await svc.chat(`[梗图:${builtin.id}]`);
  assert.equal(said.at(-1).meme.url, `assets/memes/dafeiyu/${builtin.id}.webp`);
  // the prompt the agent got listed the owner's sticker (fake lh keeps the runs it was asked for)
  const prompts = fs.readdirSync(dir).filter((f) => /\.json$|\.log$|\.txt$/.test(f)).map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } }).join('\n');
  assert.match(prompts, new RegExp(`${added[0].id}（比心：被夸的时候）`));
});
