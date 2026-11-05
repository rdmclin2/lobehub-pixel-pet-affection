'use strict';

// 上架到商店 (T-10796): the sticker market service (services/sticker-market) and the app's side of it
// (src/main/sticker-market.js publish / mine / unpublish, src/main/sticker-store.js as the community shelf).
// The HTTP service runs for real on a random port; only "who does this LobeHub token belong to" is faked, with two
// users, so ownership can be checked. Owner A publishes from a character's 「我的」 set; the maintainer approves;
// install B (another data folder, no login) sees it on the shelf, gets it for a character and can send it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SS = require('../src/core/sticker-set');
const S = require('../src/core/stickers');
const { StickerMarket } = require('../services/sticker-market/market');
const { createServer, lobehubVerifier } = require('../services/sticker-market/server');
const { StickerMarketClient } = require('../src/main/sticker-market');
const { StickerStore } = require('../src/main/sticker-store');
const { getSpecies } = require('../src/core/species');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `sticker-market-${p}-`));
const meme = (sp, id) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets', 'memes', sp, `${id}.webp`));
const claude = getSpecies('claude');
const dafeiyu = getSpecies('dafeiyu');
const USERS = { 'tok-a': { id: 'user_a', name: '主人A' }, 'tok-b': { id: 'user_b', name: '主人B' } };
const ADMIN = 'admin-secret';
const META = { name: '我的日常', description: '自己做的', license: 'CC BY 4.0', rights: true };

async function startMarket({ review = 'manual' } = {}) {
  const market = new StickerMarket({ dir: tmp('srv'), review });
  const server = createServer({ market, verify: async (t) => USERS[t] || null, adminToken: ADMIN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { market, server, base, close: () => new Promise((r) => server.close(r)) };
}
const approve = (base, id, decision = 'approve', reason) => fetch(`${base}/v1/admin/sticker-sets/${id}/review`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ decision, reason }) }).then((r) => r.json());

// an install: its own <userData>/stickers, signed in as `token` (null: not signed in)
function install(base, token) {
  const lib = new S.StickerLibrary(path.join(tmp('app'), 'stickers'));
  const client = new StickerMarketClient({ lib, base, fetch, token: async () => { if (!token) throw new Error('not signed in'); return token; } });
  const shelf = new StickerStore({ lib, fetch, community: true, url: client.catalogUrl, base: client.filesBase, names: () => ({ claude: '克洛蒂', dafeiyu: '大肥鱼' }) });
  return { lib, client, shelf };
}

test('owner A publishes 「我的」 from the app: in review until approved, then on everyone\'s shelf; B gets it and can send it', async () => {
  const m = await startMarket();
  try {
    const A = install(m.base, 'tok-a');
    const added = A.lib.add(dafeiyu, [{ name: 'a.webp', buffer: meme('dafeiyu', 'rice') }, { name: 'b.webp', buffer: meme('dafeiyu', 'cute') }, { name: 'c.webp', buffer: meme('claude', claude.memes[0].id) }]);
    assert.equal(added.added.length, 3);

    const r = await A.client.publish(dafeiyu, META);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.id, /^u-[0-9a-f]{6}-1$/);
    assert.equal(r.version, '1.0.0');
    assert.equal(r.state, 'pending');
    assert.equal(A.client.publishedId('dafeiyu'), r.id);

    // nothing on the shelf while it is in review
    const B = install(m.base, null);
    let st = await B.shelf.state({ refresh: true });
    assert.equal(st.error, null);
    assert.equal(st.sets.length, 0);
    const mine = await A.client.mine();
    assert.deepEqual(mine.sets.map((s) => [s.id, s.state, s.fromSpecies]), [[r.id, 'pending', 'dafeiyu']]);

    // the maintainer approves: B's shelf lists it, never as 官方, authored by A's LobeHub name
    assert.equal((await approve(m.base, r.id)).state, 'published');
    st = await B.shelf.state({ refresh: true });
    assert.equal(st.sets.length, 1);
    const row = st.sets[0];
    assert.deepEqual([row.id, row.name, row.author, row.official, row.count, row.license, row.version], [r.id, '我的日常', '主人A', false, 3, 'CC BY 4.0', '1.0.0']);
    assert.ok(row.coverUrl && row.coverUrl.startsWith('sticker://store/'));
    const detail = await B.shelf.detail(r.id);
    assert.equal(detail.stickers.length, 3);
    assert.ok(detail.stickers.every((x) => x.url));

    // B 获取 it for 克洛蒂 (another character than A's): it is hers, in the panel, and a sticker of it resolves to a blob
    const got = await B.shelf.get(r.id, 'claude');
    assert.equal(got.ok, true, JSON.stringify(got));
    const list = B.lib.list(claude);
    const set = list.sets.find((x) => x.kind === 'store');
    assert.equal(set.name, '商店 · 我的日常');
    assert.equal(set.stickers.length, 3);
    const pick = B.lib.resolve(claude, set.id, set.stickers[0].id);
    assert.ok(pick && (pick.ok !== false), JSON.stringify(pick));
  } finally {
    await m.close();
  }
});

test('上架 again sends a new version of the same set; the old version stays live until the new one is approved', async () => {
  const m = await startMarket();
  try {
    const A = install(m.base, 'tok-a');
    A.lib.add(dafeiyu, [{ name: 'a.webp', buffer: meme('dafeiyu', 'rice') }]);
    const v1 = await A.client.publish(dafeiyu, META);
    await approve(m.base, v1.id);
    A.lib.add(dafeiyu, [{ name: 'b.webp', buffer: meme('dafeiyu', 'cute') }]);
    const v2 = await A.client.publish(dafeiyu, { ...META, name: '我的日常 2' });
    assert.deepEqual([v2.id, v2.version, v2.state], [v1.id, '1.0.1', 'pending']);
    const idx = m.market.index();
    assert.deepEqual(idx.sets.map((s) => [s.id, s.version, s.count]), [[v1.id, '1.0.0', 1]]);
    const mine = (await A.client.mine()).sets[0];
    assert.deepEqual([mine.state, mine.version, mine.liveVersion], ['pending', '1.0.1', '1.0.0']);
    await approve(m.base, v1.id);
    assert.deepEqual(m.market.index().sets.map((s) => [s.version, s.count, s.name]), [['1.0.1', 2, '我的日常 2']]);
  } finally {
    await m.close();
  }
});

test('only the owner may update or take down a set; a rejected one says why; no login, no rights, a bad license are refused', async () => {
  const m = await startMarket();
  try {
    const A = install(m.base, 'tok-a');
    const B = install(m.base, 'tok-b');
    const N = install(m.base, null);
    A.lib.add(dafeiyu, [{ name: 'a.webp', buffer: meme('dafeiyu', 'rice') }]);
    B.lib.add(dafeiyu, [{ name: 'a.webp', buffer: meme('dafeiyu', 'cute') }]);
    N.lib.add(dafeiyu, [{ name: 'a.webp', buffer: meme('dafeiyu', 'cute') }]);
    const a = await A.client.publish(dafeiyu, META);
    await approve(m.base, a.id);

    // B cannot put a new version on A's set, nor take it down (straight at the API: the app never would)
    const zip = SS.packSet({ id: 'draft-set', name: 'x', author: 'x', license: 'CC BY 4.0', version: '1.0.0' }, [{ id: 'x', label: 'x', buffer: meme('dafeiyu', 'cute') }]).zip;
    const hijack = await fetch(`${m.base}/v1/sticker-sets?id=${a.id}`, { method: 'POST', headers: { 'Oidc-Auth': 'tok-b', 'X-Rights-Confirmed': 'yes' }, body: zip });
    assert.equal(hijack.status, 403);
    assert.equal((await fetch(`${m.base}/v1/sticker-sets/${a.id}`, { method: 'DELETE', headers: { 'Oidc-Auth': 'tok-b' } })).status, 403);
    assert.equal((await fetch(`${m.base}/v1/sticker-sets`, { method: 'POST', headers: { 'Oidc-Auth': 'forged', 'X-Rights-Confirmed': 'yes' }, body: zip })).status, 401);
    // the author is who the token belongs to, not what the zip says
    const own = await fetch(`${m.base}/v1/sticker-sets`, { method: 'POST', headers: { 'Oidc-Auth': 'tok-b', 'X-Rights-Confirmed': 'yes' }, body: SS.packSet({ id: 'draft-set', name: 'x', author: 'Pixel Pet 官方', license: 'CC BY 4.0', version: '1.0.0' }, [{ id: 'x', label: 'x', buffer: meme('dafeiyu', 'cute') }]).zip }).then((r) => r.json());
    assert.equal(own.set.author, '主人B');

    assert.equal((await N.client.publish(dafeiyu, META)).reason, 'auth');
    assert.equal((await B.client.publish(dafeiyu, { ...META, rights: false })).reason, 'rights');
    assert.equal((await B.client.publish(dafeiyu, { ...META, license: 'WTFPL' })).reason, 'license');
    assert.equal((await fetch(`${m.base}/v1/sticker-sets`, { method: 'POST', headers: { 'Oidc-Auth': 'tok-b' }, body: zip })).status, 400);

    // rejected: the owner sees why; nothing goes on the shelf
    const b = await B.client.publish(dafeiyu, META);
    await approve(m.base, b.id, 'reject', '图片含有不适合全年龄的内容');
    const bm = (await B.client.mine()).sets.find((s) => s.id === b.id);
    assert.deepEqual([bm.state, bm.rejectReason], ['rejected', '图片含有不适合全年龄的内容']);
    assert.ok(!m.market.index().sets.some((s) => s.id === b.id));

    // A takes theirs down: gone from the shelf and from 我上架的
    assert.equal((await A.client.unpublish(a.id)).ok, true);
    assert.equal(m.market.index().sets.length, 0);
    assert.equal((await A.client.mine()).sets.length, 0);
    assert.equal(A.client.publishedId('dafeiyu'), null);
  } finally {
    await m.close();
  }
});

test('the market refuses a hostile zip and a request without the admin token; the empty market is a valid shelf', async () => {
  const m = await startMarket();
  try {
    const evil = SS.buildZip([{ name: 'sticker-set.json', data: Buffer.from(JSON.stringify({ schema: 1, id: 'x-set', name: 'x', author: 'x', license: 'CC BY 4.0', stickers: [{ id: 'x', label: 'x', file: 'stickers/x.webp' }] })) }, { name: '../evil.webp', data: meme('dafeiyu', 'rice') }]);
    const r = await fetch(`${m.base}/v1/sticker-sets`, { method: 'POST', headers: { 'Oidc-Auth': 'tok-a', 'X-Rights-Confirmed': 'yes' }, body: evil });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).reason, 'bad-path');
    assert.equal((await fetch(`${m.base}/v1/admin/pending`)).status, 403);
    assert.equal((await fetch(`${m.base}/v1/files/..%2Fdb.json`)).status, 404);
    const B = install(m.base, null);
    const st = await B.shelf.state({ refresh: true });
    assert.deepEqual([st.error, st.sets.length, st.source], [null, 0, 'remote']);
  } finally {
    await m.close();
  }
});

test('auto review puts a set on the shelf at once; the app client says when the market is off or unreachable', async () => {
  const m = await startMarket({ review: 'auto' });
  try {
    const A = install(m.base, 'tok-a');
    A.lib.add(dafeiyu, [{ name: 'a.webp', buffer: meme('dafeiyu', 'rice') }]);
    const r = await A.client.publish(dafeiyu, META);
    assert.equal(r.state, 'published');
    assert.equal(m.market.index().sets.length, 1);
  } finally {
    await m.close();
  }
  const off = new StickerMarketClient({ lib: new S.StickerLibrary(tmp('off')), base: null, fetch, token: async () => 'tok-a' });
  assert.equal((await off.mine()).reason, 'off');
  const down = new StickerMarketClient({ lib: new S.StickerLibrary(tmp('down')), base: 'http://127.0.0.1:9', fetch, token: async () => 'tok-a' });
  assert.equal((await down.mine()).reason, 'network');
});

test('lobehubVerifier asks LobeHub who the token is and caches the answer; an invalid token is nobody', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts.headers['Oidc-Auth']]);
    if (opts.headers['Oidc-Auth'] !== 'good') return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ result: { data: { json: { userId: 'user_x', username: 'xx', fullName: '小明' } } } }) };
  };
  const verify = lobehubVerifier({ server: 'https://lh.example/', fetchFn });
  assert.deepEqual(await verify('good'), { id: 'user_x', name: '小明' });
  assert.deepEqual(await verify('good'), { id: 'user_x', name: '小明' });
  assert.equal(await verify('bad'), null);
  assert.deepEqual(calls, [['https://lh.example/trpc/lambda/user.getUserState', 'good'], ['https://lh.example/trpc/lambda/user.getUserState', 'bad']]);
});
