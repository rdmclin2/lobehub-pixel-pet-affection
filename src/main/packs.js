'use strict';

// Pet packs on disk: the built-in ones (src/renderer/packs) and the user's own (<userData>/packs),
// served to the renderer over `pack://<id>/<file>`. Importing copies a pack folder (or a .zip of one)
// into the user folder after checking it with src/core/packs.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, protocol, net } = require('electron');
const P = require('../core/packs');
const Catalog = require('../core/catalog');
const { importVrm } = require('../core/vrm-import');

// Must run before the app is ready. CORS-enabled so the page can read a sheet's pixels (部位触摸 hit-tests
// clicks against her opaque pixels); the files are pictures only, see serve().
// (registerSchemesAsPrivileged may be called only once: the VRM motion library's vrmlib:// is registered here too,
// it is served by src/main/vrm-library.js)
function registerPackScheme() {
  protocol.registerSchemesAsPrivileged([
    // stream: a downloaded video character's clips play from pack://<base>-clips (media needs range requests)
    { scheme: 'pack', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    { scheme: 'vrmlib', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, _o, stderr) => (e ? reject(new Error(String(stderr || e.message).trim().slice(0, 200))) : resolve())));

function unzip(zip, dest) {
  if (process.platform === 'darwin') return run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
  if (process.platform === 'win32') return run('tar', ['-xf', zip, '-C', dest]); // bsdtar ships with Windows 10+
  return run('unzip', ['-q', zip, '-d', dest]);
}

// Zip the contents of `dir` into `zip` (the folder's files at the zip's top level, as 导入角色包… reads them).
function zipDir(dir, zip) {
  if (process.platform === 'darwin') return run('/usr/bin/ditto', ['-c', '-k', dir, zip]);
  if (process.platform === 'win32') return run('tar', ['-a', '-cf', zip, '-C', dir, '.']);
  return run('python3', ['-m', 'zipfile', '-c', zip, ...fs.readdirSync(dir).map((f) => path.join(dir, f))]);
}

const NO_CUBISM2 = '这是 Cubism 2 的模型（.model.json），目前只支持 Cubism 3 / 4 / 5（.model3.json）';
const MAX_LIVE2D_BYTES = 300 * 1024 * 1024;
// a 1×1 transparent PNG: an imported model's picture until the renderer has drawn the real one
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) n += dirSize(f);
    else if (e.isFile()) n += fs.statSync(f).size;
    if (n > MAX_LIVE2D_BYTES) break;
  }
  return n;
}

class PackStore {
  constructor() {
    this.builtinDir = path.join(__dirname, '..', 'renderer', 'packs');
    this.userDir = path.join(app.getPath('userData'), 'packs');
    // downloaded clips (a video character's, `<base>-clips`, core/catalog.js); downloaded packs go to userDir
    this.clipsDir = path.join(app.getPath('userData'), 'clips');
    fs.mkdirSync(this.userDir, { recursive: true });
    fs.mkdirSync(this.clipsDir, { recursive: true });
    // tests only: a folder laid out as catalog/ (packs/, clips/) counts as downloaded, so the e2e scenarios
    // that are not about downloading find every character without fetching 100 MB first
    const pre = process.env.PIXELPET_TEST === '1' && process.env.PIXELPET_CATALOG_PREINSTALLED;
    this.preinstalled = pre && fs.existsSync(pre) ? path.resolve(pre) : null;
    this.reload();
  }

  reload() {
    const roots = [{ dir: this.builtinDir, source: 'builtin' }, { dir: this.userDir, source: 'user' }];
    if (this.preinstalled) roots.push({ dir: path.join(this.preinstalled, 'packs'), source: 'download' });
    const { packs, problems } = P.loadPacks(roots);
    // a pack in the user folder that came from the catalog carries its marker: 下载, not 导入
    for (const [id, p] of packs) if (p.source === 'user' && fs.existsSync(path.join(p.dir, Catalog.MARKER))) packs.set(id, { ...p, source: 'download' });
    this.clipDirs = new Map();
    for (const root of [this.clipsDir, this.preinstalled && path.join(this.preinstalled, 'clips')].filter(Boolean)) {
      let names = [];
      try {
        names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /-clips$/.test(d.name)).map((d) => d.name);
      } catch {
        continue;
      }
      for (const id of names) if (!this.clipDirs.has(id) && Catalog.entry(id)) this.clipDirs.set(id, path.join(root, id));
    }
    packs.clips = new Set(this.clipDirs.keys()); // core/characters.js hasClips
    this.packs = packs;
    this.problems = problems;
    return packs;
  }

  // Is catalog character `id` on this machine (downloaded, or preinstalled for tests)?
  installed(id) {
    const p = this.packs.get(id);
    return this.clipDirs.has(id) || !!(p && p.source !== 'user');
  }

  // Put a downloaded, already checked archive of catalog character `entry` in place (src/main/catalog.js).
  // The folder is assembled next to its final place and renamed in, so a failure never leaves half a character.
  async installDownload(entry, zipFile) {
    const root = entry.type === 'clips' ? this.clipsDir : this.userDir;
    const tmp = fs.mkdtempSync(path.join(root, `.${entry.id}-`));
    try {
      await unzip(zipFile, tmp);
      if (entry.type === 'pack') {
        const r = P.readPack(tmp);
        if (!r.ok) return { ok: false, reason: 'invalid', errors: r.errors };
        if (r.pack.id !== entry.id) return { ok: false, reason: 'invalid', errors: [`the archive holds ${r.pack.id}, not ${entry.id}`] };
        const existing = this.packs.get(entry.id);
        if (existing && existing.source === 'builtin') return { ok: false, reason: 'builtin', errors: [`${entry.id} ships with the app`] };
      } else {
        const sp = require('../core/species').SPECIES[entry.base];
        const missing = sp && sp.clips ? Object.values(sp.clips).flat().filter((f) => !fs.existsSync(path.join(tmp, f))) : ['clips'];
        if (missing.length) return { ok: false, reason: 'invalid', errors: [`missing ${missing.join(', ')}`] };
      }
      fs.writeFileSync(path.join(tmp, Catalog.MARKER), `${JSON.stringify({ id: entry.id, version: entry.version || '', sha256: entry.sha256, installedAt: new Date().toISOString() }, null, 2)}\n`);
      const dest = path.join(root, entry.id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      this.reload();
      return { ok: true, id: entry.id };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 删除下载: a downloaded character's files go; she can be downloaded again (her wardrobe is kept by id).
  removeDownload(id) {
    if (this.clipDirs.has(id)) {
      const dir = this.clipDirs.get(id);
      if (!dir.startsWith(this.clipsDir + path.sep)) return { ok: false, reason: 'preinstalled' };
      fs.rmSync(dir, { recursive: true, force: true });
      this.reload();
      return { ok: true };
    }
    const p = this.packs.get(id);
    if (!p || p.source !== 'download') return { ok: false, reason: 'not-downloaded' };
    if (!p.dir.startsWith(this.userDir + path.sep)) return { ok: false, reason: 'preinstalled' };
    fs.rmSync(p.dir, { recursive: true, force: true });
    this.reload();
    return { ok: true };
  }

  // pack://<id>/<file>: only files inside that pack's folder.
  serve() {
    protocol.handle('pack', (req) => {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      // pack://<base>-clips/<clip>.webm: a downloaded video character's clips
      const clips = this.clipDirs.get(u.hostname);
      const pack = clips ? { dir: clips } : this.packs.get(u.hostname);
      const file = pack && path.resolve(pack.dir, rel);
      const allowed = clips ? /\.(webm|png)$/i : /\.(png|webp|gif|jpe?g|json|moc3|vrma?)$/i;
      if (!pack || !file.startsWith(pack.dir + path.sep) || !allowed.test(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString()).then((res) => {
        const headers = new Headers(res.headers);
        headers.set('access-control-allow-origin', '*');
        return new Response(res.body, { status: res.status, headers });
      });
    });
  }

  // Import a pack folder or a .zip holding one (pack.json at its top or one folder down). A pack with the
  // id of a built-in one is refused; one with the id of an imported one replaces it.
  async importFrom(src) {
    let dir = src;
    let tmp = null;
    try {
      if (/\.zip$/i.test(src)) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-pack-'));
        await unzip(src, tmp);
        dir = fs.existsSync(path.join(tmp, 'pack.json')) ? tmp : fs.readdirSync(tmp, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(tmp, d.name, 'pack.json'))).map((d) => path.join(tmp, d.name))[0];
        if (!dir) return { ok: false, errors: ['the .zip has no pack.json'] };
      }
      const r = P.readPack(dir);
      if (!r.ok) return r;
      const existing = this.packs.get(r.pack.id);
      if (existing && existing.source === 'builtin') return { ok: false, errors: [`id ${r.pack.id} belongs to a built-in pack; give the pack its own id`] };
      const dest = path.join(this.userDir, r.pack.id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(dir, dest, { recursive: true, dereference: true });
      this.reload();
      return { ok: true, pack: { id: r.pack.id, name: r.pack.name, species: r.pack.species }, characterId: r.pack.id, replaced: !!existing };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Import the user's own Live2D model as a new character on base `speciesId` (T-2764: its id is the pack's) (外观 → 导入 Live2D 模型…): a .model3.json, the folder
  // holding one, or a .zip of it. The model's folder is copied into a new pack (core/packs.js live2dManifest);
  // the renderer then draws its preview (savePreview), or removes it when the model will not load.
  async importLive2d(src, speciesId) {
    let tmp = null;
    try {
      let root = src;
      let pick = null;
      if (/\.zip$/i.test(src)) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-l2d-'));
        await unzip(src, tmp);
        root = tmp;
      } else if (/\.json$/i.test(src)) {
        if (!/\.model3\.json$/i.test(src)) return { ok: false, errors: [/\.model\.json$/i.test(src) ? NO_CUBISM2 : '请选择模型的 .model3.json 文件，或包含它的文件夹 / .zip'] };
        root = path.dirname(src);
        pick = path.basename(src);
      }
      const { models, cubism2 } = P.findLive2dModels(root);
      if (!pick) {
        if (!models.length) return { ok: false, errors: [cubism2 ? NO_CUBISM2 : '没有找到 .model3.json（支持 Cubism 3 / 4 / 5 的模型）'] };
        if (models.length > 1) return { ok: false, errors: [`找到 ${models.length} 个模型（${models.slice(0, 3).map((m) => path.basename(m)).join('、')}…），请直接选择其中一个 .model3.json`] };
        pick = models[0];
      }
      const modelFile = path.join(root, pick);
      const modelDir = path.dirname(modelFile);
      let model3;
      try {
        model3 = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
      } catch {
        return { ok: false, errors: [`${path.basename(modelFile)} 不是有效的 JSON`] };
      }
      const size = dirSize(modelDir);
      if (size > MAX_LIVE2D_BYTES) return { ok: false, errors: [`模型文件夹太大（${Math.round(size / 1048576)} MB，最多 ${MAX_LIVE2D_BYTES / 1048576} MB）`] };
      // the expressions it names, read for the app's faces (blush, surprise, …)
      const refs = (model3 && model3.FileReferences) || {};
      const expressions = (Array.isArray(refs.Expressions) ? refs.Expressions : []).slice(0, 64).map((e) => {
        const file = e && typeof e.File === 'string' ? e.File : '';
        const abs = path.resolve(modelDir, file);
        let json = null;
        if (file && abs.startsWith(modelDir + path.sep)) {
          try { json = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { /* a broken expression is left out */ }
        }
        return { name: e && e.Name, file, json };
      });
      const baseName = path.basename(modelFile).replace(/\.model3\.json$/i, '');
      const name = baseName === 'model' || !baseName ? path.basename(modelDir) : baseName;
      const manifest = P.live2dManifest({ speciesId, modelRel: path.basename(modelFile), name, expressions });
      const existing = this.packs.get(manifest.id);
      if (existing && existing.source === 'builtin') return { ok: false, errors: ['这个名字已被内置角色包占用'] };
      const dest = path.join(this.userDir, manifest.id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(modelDir, path.join(dest, P.LIVE2D_DIR), { recursive: true, dereference: true });
      fs.writeFileSync(path.join(dest, P.PREVIEW_FILE), BLANK_PNG);
      fs.writeFileSync(path.join(dest, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const r = P.readPack(dest);
      if (!r.ok) {
        fs.rmSync(dest, { recursive: true, force: true });
        return { ok: false, errors: r.errors };
      }
      this.reload();
      const pack = this.packs.get(manifest.id);
      return { ok: true, pack: { id: pack.id, name: pack.name, species: pack.species }, characterId: pack.id, model: P.packUrl(pack, pack.model), faces: Object.keys(pack.live2d.faces), replaced: !!existing };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Import the user's own VRM model for `speciesId` (外观 → 导入 VRM 模型…): a .vrm, a folder or a .zip. Only
  // <userData>/packs is written (core/vrm-import.js); the license read from the model goes with the pack.
  async importVrm(src, speciesId) {
    const r = await importVrm({ src, speciesId, userDir: this.userDir, packs: this.packs, unzipFn: unzip });
    if (!r.ok) return r;
    this.reload();
    const pack = this.packs.get(r.pack.id);
    return { ...r, pack: { id: pack.id, name: pack.name, species: pack.species }, characterId: pack.id, model: P.packUrl(pack, pack.outfits.daily || Object.values(pack.outfits)[0]) };
  }

  // The picture an imported Live2D model shows in lists and the wardrobe, drawn by the renderer (PNG data URL).
  savePreview(id, dataUrl) {
    const p = this.packs.get(id);
    if (!p || p.source !== 'user' || (p.kind !== 'live2d' && p.kind !== 'vrm')) return { ok: false, reason: 'not-user-live2d' };
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    const buf = m && Buffer.from(m[1], 'base64');
    if (!buf || buf.length < 8 || buf.length > 8 * 1024 * 1024 || !buf.subarray(0, 8).equals(BLANK_PNG.subarray(0, 8))) return { ok: false, reason: 'bad-png' };
    fs.writeFileSync(path.join(p.dir, P.PREVIEW_FILE), buf);
    this.reload();
    return { ok: true };
  }

  // Her size in the window for an imported Live2D model (live2d.height in its pack.json, 0.3–1).
  setLive2dHeight(id, height) {
    const p = this.packs.get(id);
    if (!p || p.source !== 'user' || p.kind !== 'live2d') return { ok: false, reason: 'not-user-live2d' };
    const h = Math.round(Math.min(1, Math.max(0.3, Number(height) || 0.8)) * 100) / 100;
    const file = path.join(p.dir, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.live2d = { ...(manifest.live2d || {}), height: h };
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    this.reload();
    return { ok: true, height: h };
  }

  // May this pack leave the machine (导出…)? A VRM pack whose model may not be redistributed never may
  // (core/packs.js packShareable); built-in packs ship with the app and are not exported.
  shareable(id) {
    const p = this.packs.get(id);
    if (!p) return { ok: false, reason: 'unknown', text: '没有这个角色包' };
    if (p.source !== 'user') return { ok: false, reason: 'builtin', text: p.source === 'download' ? '下载的角色可以随时从角色图鉴重新下载，不需要导出' : '内置角色包随应用提供，不需要导出' };
    return P.packShareable(p);
  }

  // Export a user pack as a .zip that 导入角色包… reads back. Refused (nothing written) when not shareable.
  async exportPack(id, zip) {
    const ok = this.shareable(id);
    if (!ok.ok) return ok;
    const p = this.packs.get(id);
    fs.rmSync(zip, { force: true });
    await zipDir(p.dir, zip);
    return { ok: true, file: zip };
  }

  remove(id) {
    const p = this.packs.get(id);
    if (!p || p.source !== 'user') return { ok: false, reason: 'not-user-pack' };
    fs.rmSync(p.dir, { recursive: true, force: true });
    this.reload();
    return { ok: true };
  }
}

module.exports = { registerPackScheme, PackStore };
