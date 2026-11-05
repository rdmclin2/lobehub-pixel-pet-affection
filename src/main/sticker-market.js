'use strict';

// 上架到商店 in the main process (T-10796; docs/stickers-design.md §5.2 方案 C): an owner puts a character's
// 「我的」 set on the community shelf, sees whether it is still in review, and takes it down again.
//
//   publish(species, { name, description, license, rights })   pack her 「我的」 set (core/sticker-set.js packSet,
//                                                              the zip every install reads) and POST it to the
//                                                              sticker market with the owner's LobeHub token
//   mine()       GET /v1/me/sticker-sets: what this LobeHub account put up, with review state
//   unpublish(id)
//
// Which store set a character's 「我的」 became is remembered in <userData>/stickers/published.json, so 上架 again
// sends a new version of the same set instead of a second one. The token is the one `lh login` saved (core/
// responses-client.js _token); the market asks LobeHub who it belongs to and names the author from that — the
// app never sends a name of its own. Browsing the community shelf is src/main/sticker-store.js over the
// market's /v1/sticker-catalog.json, like the official shelf over the CDN.
//
// Electron is not required here: main passes net.fetch; the tests pass their own.

const fs = require('node:fs');
const path = require('node:path');
const SS = require('../core/sticker-set');

const LICENSES = SS.COMMUNITY_LICENSES;
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const no = (reason, msg) => ({ ok: false, reason, text: msg });

class StickerMarketClient {
  // `lib`: core/stickers.js StickerLibrary; `base`: the market (PIXELPET_STICKER_MARKET_URL; null = off);
  // `token()`: the LobeHub access token (throws when not signed in); `fetch`: net.fetch.
  constructor({ lib, base, token, fetch: fetchFn, log = () => {} }) {
    this.lib = lib;
    this.base = base ? String(base).replace(/\/+$/, '') : null;
    this.token = token;
    this.fetch = fetchFn;
    this.log = log;
    this.mapFile = path.join(lib.dir, 'published.json');
  }

  get configured() { return !!this.base; }
  get catalogUrl() { return this.base ? `${this.base}/v1/sticker-catalog.json` : ''; }
  get filesBase() { return this.base ? `${this.base}/v1/files` : null; }

  _map() { try { const m = JSON.parse(fs.readFileSync(this.mapFile, 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; } }
  _saveMap(m) {
    fs.mkdirSync(path.dirname(this.mapFile), { recursive: true });
    const tmp = `${this.mapFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, this.mapFile);
  }
  publishedId(speciesId) { return this._map()[speciesId] || null; }

  async _call(method, p, { body = null, headers = {}, auth = true } = {}) {
    if (!this.base) return no('off', '表情包社区商店还没有配置');
    let token = null;
    if (auth) {
      try { token = await this.token(); } catch { return no('auth', '请先登录 LobeHub（在 设置 → 账号 里登录）后再上架'); }
      if (!token) return no('auth', '请先登录 LobeHub（在 设置 → 账号 里登录）后再上架');
    }
    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 60000);
      res = await this.fetch(`${this.base}${p}`, { method, body, headers: { ...(token ? { 'Oidc-Auth': token } : {}), ...headers }, signal: ctrl.signal }).finally(() => clearTimeout(t));
    } catch (e) {
      this.log(new Error(`sticker market ${method} ${p}: ${(e && e.message) || e}`));
      return no('network', '连不上表情包商店，请检查网络后重试');
    }
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    if (!res.ok || !j || j.ok === false) return no((j && j.reason) || 'http', (j && j.text) || `表情包商店暂时不可用（HTTP ${res.status}）`);
    return j;
  }

  // -> { ok, id, version, state: 'pending' | 'published', set } | { ok: false, reason, text }
  async publish(species, meta = {}) {
    if (!species || !species.id) return no('bad-species', '没有这位角色');
    const name = text(meta.name, 30);
    if (!name) return no('name', '请填写表情包名称');
    const license = LICENSES.includes(meta.license) ? meta.license : null;
    if (!license) return no('license', '请选择授权方式');
    if (meta.rights !== true) return no('rights', '需要确认你有权发布这些图片');
    const mine = this.lib._readMine(species.id);
    if (!mine.stickers.length) return no('empty', '「我的」里还没有表情包，先添加几张再上架');
    const pictures = [];
    for (const s of mine.stickers) {
      const file = this.lib.blobPath(s.blob);
      if (!file) return no('missing', `「${s.label}」的图片文件不见了，删掉它再上架`);
      pictures.push({ id: s.id, label: s.label, desc: s.desc || '', buffer: fs.readFileSync(file) });
    }
    // id / author / version here are placeholders: the market assigns its own (and the author from LobeHub)
    const packed = SS.packSet({ id: 'draft-set', name, description: text(meta.description, 200), author: 'owner', license, version: '1.0.0', forSpecies: [species.id], cover: pictures[0].id }, pictures);
    if (!packed.ok) return no(packed.reason, packed.errors[0] || '表情包打包失败');
    const existing = this.publishedId(species.id);
    const q = existing ? `?id=${encodeURIComponent(existing)}` : '';
    let r = await this._call('POST', `/v1/sticker-sets${q}`, { body: packed.zip, headers: { 'Content-Type': 'application/zip', 'X-Rights-Confirmed': 'yes' } });
    // the set we remembered was taken down (or the market was reset): put it up as a new one
    if (!r.ok && existing && r.reason === 'unknown') r = await this._call('POST', '/v1/sticker-sets', { body: packed.zip, headers: { 'Content-Type': 'application/zip', 'X-Rights-Confirmed': 'yes' } });
    if (!r.ok) return r;
    const m = this._map();
    m[species.id] = r.id;
    this._saveMap(m);
    return { ok: true, id: r.id, version: r.version, state: r.state, set: r.set };
  }

  // -> { ok, sets: [{ id, state, name, version, liveVersion, rejectReason, … }], user } | { ok: false, reason, text }
  async mine() {
    const r = await this._call('GET', '/v1/me/sticker-sets');
    if (!r.ok) return r;
    const bySet = Object.fromEntries(Object.entries(this._map()).map(([sp, id]) => [id, sp]));
    return { ok: true, sets: r.sets.map((s) => ({ ...s, fromSpecies: bySet[s.id] || null })), user: r.user || null };
  }

  async unpublish(id) {
    const r = await this._call('DELETE', `/v1/sticker-sets/${encodeURIComponent(String(id || ''))}`);
    if (!r.ok) return r;
    const m = this._map();
    for (const [sp, sid] of Object.entries(m)) if (sid === id) delete m[sp];
    this._saveMap(m);
    return { ok: true, id };
  }
}

module.exports = { StickerMarketClient, LICENSES };
