'use strict';
// T-2839: the owner's LobeHub avatar for the console's chat (src/core/user-avatar.js), and every built-in
// character's drawn face (art.avatar → SPECIES[id].avatar → roster rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { userAvatar, avatarUrl } = require('../src/core/user-avatar');
const { SPECIES, SPECIES_IDS, validateCharacter, missingFiles } = require('../src/core/species');
const { buildRoster } = require('../src/core/roster');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a5f0a1e90000000049454e44ae426082', 'hex');
const image = (buf = PNG, type = 'image/png') => async () => new Response(buf, { status: 200, headers: { 'content-type': type } });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uavatar-')), 'user-avatar.json');
const ME = { name: 'Lin', avatar: '/webapi/user/avatar/u1/a.webp' };

test('avatarUrl: a server path is resolved against the LobeHub server; full URLs and data: URLs pass; others are refused', () => {
  assert.equal(avatarUrl('/webapi/user/avatar/u1/a.webp', 'https://app.lobehub.com/'), 'https://app.lobehub.com/webapi/user/avatar/u1/a.webp');
  assert.equal(avatarUrl('https://cdn.example.com/a.png', 'https://app.lobehub.com'), 'https://cdn.example.com/a.png');
  assert.equal(avatarUrl('data:image/png;base64,AAAA', 'https://x'), 'data:image/png;base64,AAAA');
  for (const bad of [null, '', '   ', 'file:///etc/passwd', 'javascript:alert(1)', 42]) assert.equal(avatarUrl(bad, 'https://app.lobehub.com'), null, String(bad));
});

test('userAvatar fetches the account avatar once, as a data: URL, and caches it by URL', async () => {
  const cacheFile = tmpFile();
  const urls = [];
  const fetchImpl = async (u) => (urls.push(u), image()());
  const a = await userAvatar({ whoami: async () => ME, server: 'https://app.lobehub.com', cacheFile, fetchImpl });
  assert.equal(a.name, 'Lin');
  assert.equal(a.avatar, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(urls, ['https://app.lobehub.com/webapi/user/avatar/u1/a.webp']);
  const b = await userAvatar({ whoami: async () => ME, server: 'https://app.lobehub.com', cacheFile, fetchImpl });
  assert.equal(b.avatar, a.avatar);
  assert.equal(urls.length, 1, 'same URL: served from the cache');
  await userAvatar({ whoami: async () => ({ ...ME, avatar: '/webapi/user/avatar/u1/b.webp' }), server: 'https://app.lobehub.com', cacheFile, fetchImpl });
  assert.equal(urls.length, 2, 'a new picture is fetched');
});

test('userAvatar: the cached face only for the same avatar URL; never another account\'s, never after logout', async () => {
  const cacheFile = tmpFile();
  const down = async () => { throw new Error('ENOTFOUND'); };
  const first = await userAvatar({ whoami: async () => ME, server: 'https://s', cacheFile, fetchImpl: image() });
  assert.ok(first.avatar);
  // the same account while the server is down: the cached picture (no fetch needed)
  assert.equal((await userAvatar({ whoami: async () => ME, server: 'https://s', cacheFile, fetchImpl: down })).avatar, first.avatar);
  // lh cannot run at all: who is logged in is unknown, so nobody's face
  assert.equal((await userAvatar({ whoami: async () => { throw new Error('lh not found'); }, server: 'https://s', cacheFile, fetchImpl: down })).avatar, null);
  // another account (another avatar URL) and its picture cannot be fetched: nobody's face, not the old one
  assert.equal((await userAvatar({ whoami: async () => ({ name: 'B', avatar: '/webapi/user/avatar/u2/b.webp' }), server: 'https://s', cacheFile, fetchImpl: down })).avatar, null);
  // logged out: nobody's face
  assert.deepEqual(await userAvatar({ whoami: async () => null, server: 'https://s', cacheFile, fetchImpl: image() }), { name: '', avatar: null });
  // the account has no avatar (any more)
  assert.equal((await userAvatar({ whoami: async () => ({ name: 'Lin', avatar: null }), server: 'https://s', cacheFile, fetchImpl: image() })).avatar, null);
});

test('userAvatar refuses what is not a picture, too big, or an error page; never throws', async () => {
  const run = (fetchImpl) => userAvatar({ whoami: async () => ME, server: 'https://s', cacheFile: tmpFile(), fetchImpl });
  assert.equal((await run(image(Buffer.from('<html>'), 'text/html'))).avatar, null);
  assert.equal((await run(image(Buffer.alloc(3 * 1024 * 1024), 'image/png'))).avatar, null);
  assert.equal((await run(async () => new Response('no', { status: 404 }))).avatar, null);
  assert.deepEqual(await userAvatar({ whoami: async () => null, server: 'https://s', cacheFile: tmpFile(), fetchImpl: image() }), { name: '', avatar: null });
  // a data: URL from whoami gets the same type and size checks
  const asData = (avatar) => userAvatar({ whoami: async () => ({ name: 'Lin', avatar }), server: 'https://s', cacheFile: tmpFile(), fetchImpl: image() });
  const ok = `data:image/png;base64,${PNG.toString('base64')}`;
  assert.equal((await asData(ok)).avatar, ok);
  assert.equal((await asData(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).avatar, null);
  assert.equal((await asData(`data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString('base64')}`)).avatar, null);
});

test('every built-in character has a drawn avatar in her default pack (scripts/art/make_avatars.py)', () => {
  for (const id of SPECIES_IDS.filter((x) => !SPECIES[x].virtual)) {
    const sp = SPECIES[id];
    assert.equal(sp.avatar, `pack://${sp.defaultPack}/avatar.webp`, id);
    const file = path.join(__dirname, '..', 'src', 'renderer', 'packs', sp.defaultPack, 'avatar.webp');
    const head = fs.readFileSync(file);
    assert.equal(head.subarray(0, 4).toString(), 'RIFF', `${id}: a WebP`);
    assert.equal(head.subarray(8, 12).toString(), 'WEBP', `${id}: a WebP`);
  }
});

test('art.avatar is checked: a file name in her default pack that exists', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', 'claude.json'), 'utf8'));
  assert.deepEqual(validateCharacter(c), []);
  assert.deepEqual(missingFiles(c), []);
  assert.ok(validateCharacter({ ...c, art: { ...c.art, avatar: '../x.webp' } }).some((e) => /art\.avatar/.test(e)));
  assert.ok(validateCharacter({ ...c, art: { ...c.art, avatar: 'face.svg' } }).some((e) => /art\.avatar/.test(e)));
  assert.deepEqual(missingFiles({ ...c, art: { ...c.art, avatar: 'nope.webp' } }), ['packs/claude-pixel/nope.webp']);
});

test('roster rows: the looks her character file lists (and her clips) show her drawn face; any other look its own picture', () => {
  const rows = buildRoster(null, null);
  for (const r of rows.filter((x) => SPECIES[x.base] && SPECIES[x.base].avatar)) assert.equal(r.avatar, SPECIES[r.base].avatar, r.id);
  const row = (id, source, kind = 'pictures') => buildRoster(null, null, { characters: [{ id, base: 'claude', kind, pack: { id, name: id, kind, source }, look: { kind, url: `pack://${id}/preview.png` } }] })[0];
  assert.equal(row('claude-classic', 'download').avatar, SPECIES.claude.avatar, 'her classic pack (art.packs)');
  assert.equal(row('claude-adult', 'download').avatar, SPECIES.claude.avatar, 'her 18+ pack (art.packs)');
  const imported = row('my-vrm', 'user', 'vrm');
  assert.equal(imported.avatar, null, 'an imported look');
  assert.equal(imported.preview.url, 'pack://my-vrm/preview.png');
  assert.equal(row('vrm-store-girl', 'download', 'vrm').avatar, null, 'a store VRM on her base is not drawn after her');
  const dafeiyuClips = buildRoster(null, null, { characters: [{ id: 'dafeiyu-clips', base: 'dafeiyu', kind: 'video', pack: { id: 'dafeiyu-clips', name: 'x', kind: 'video', source: 'download' }, look: null }] })[0];
  assert.equal(dafeiyuClips.avatar, SPECIES.dafeiyu.avatar, 'her clips');
});
