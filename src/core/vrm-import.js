'use strict';

// Importing the user's own VRM model (外观 → 导入 VRM 模型…): a .vrm file, a folder holding .vrm files, or a
// .zip of one becomes a user pack in <userData>/packs/<id> with a generated pack.json — nothing to write by
// hand. Only the user data folder is written; never the app's own folders (src/, the repository, the
// installed app). Electron-free so the whole flow is tested (test/vrm.test.js); src/main/packs.js calls it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const P = require('./packs');
const V = require('./vrm');
const { OUTFITS } = require('./outfits');

const VRM_DIR = 'models';
const SKIP_DIRS = new Set(['__MACOSX', 'node_modules', '.git']);
// The app's own folder (the repository in development, the app bundle when installed): never written to.
const APP_ROOT = path.resolve(__dirname, '..', '..');
// a 1×1 transparent PNG: the picture for lists and the wardrobe until the renderer draws the model
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, _o, stderr) => (e ? reject(new Error(String(stderr || e.message).trim().slice(0, 200))) : resolve())));
function unzip(zip, dest) {
  if (process.platform === 'darwin') return run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
  if (process.platform === 'win32') return run('tar', ['-xf', zip, '-C', dest]);
  return run('unzip', ['-q', zip, '-d', dest]);
}

// The .vrm files under `dir` (relative, '/'-separated, shallowest first), skipping zip debris.
function findVrmFiles(dir, maxDepth = 4) {
  const found = [];
  const walk = (rel, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(r, depth + 1);
      else if (e.isFile() && /\.vrm$/i.test(e.name) && !e.name.startsWith('._')) found.push(r);
    }
  };
  walk('', 0);
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

const ALL_AGES = OUTFITS.filter((o) => o.rating === 'all').map((o) => o.id);
const ADULT = new Set(OUTFITS.filter((o) => o.rating === 'adult').map((o) => o.id));

// Which model dresses which outfit. One model: every all-ages outfit. Several: each file named after an
// outfit id (daily.vrm, pajamas.vrm, …) dresses that outfit, and a `daily` one is required. Adult outfits
// are never mapped by the importer. Returns { outfits: { id: file } } or { error }.
function mapVrmOutfits(files) {
  if (!files.length) return { error: '没有找到 .vrm 文件' };
  if (files.length === 1) return { outfits: Object.fromEntries(ALL_AGES.map((id) => [id, files[0]])) };
  const byName = {};
  for (const f of files) {
    const id = path.basename(f).replace(/\.vrm$/i, '');
    if (ALL_AGES.includes(id) && !byName[id]) byName[id] = f;
  }
  if (!byName.daily) {
    const adultOnly = files.some((f) => ADULT.has(path.basename(f).replace(/\.vrm$/i, '')));
    return { error: `找到 ${files.length} 个 .vrm（${files.slice(0, 3).map((f) => path.basename(f)).join('、')}…）。请只选其中一个，或按服饰命名（daily.vrm、pajamas.vrm…，必须有 daily.vrm）${adultOnly ? '；成人向服饰不会通过导入添加' : ''}` };
  }
  return { outfits: byName };
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Import `src` (a .vrm, a folder, or a .zip) for `speciesId` into `userDir`. `packs` is the loaded pack map
// (a built-in id is never replaced). Returns { ok: true, pack, model, license, replaced } or { ok: false, errors }.
async function importVrm({ src, speciesId, userDir, packs = new Map(), unzipFn = unzip, appRoot = APP_ROOT }) {
  const dest0 = path.resolve(userDir);
  if (inside(dest0, path.resolve(appRoot))) return { ok: false, errors: ['角色包只能导入到用户数据目录，不会写进应用目录'] };
  let tmp = null;
  try {
    let root;
    let files;
    if (/\.zip$/i.test(src)) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-vrm-'));
      await unzipFn(src, tmp);
      root = tmp;
      files = findVrmFiles(root);
    } else if (/\.vrm$/i.test(src)) {
      root = path.dirname(src);
      files = [path.basename(src)];
    } else if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
      root = src;
      files = findVrmFiles(root);
    } else {
      return { ok: false, errors: ['请选择 .vrm 文件，或包含它的文件夹 / .zip'] };
    }
    const map = mapVrmOutfits(files);
    if (map.error) return { ok: false, errors: [map.error] };
    // read every model first: not a VRM, too large or broken → nothing is copied
    const metas = {};
    for (const f of new Set(Object.values(map.outfits))) {
      const abs = path.join(root, f);
      const st = fs.statSync(abs);
      if (st.size > P.MAX_VRM_BYTES) return { ok: false, errors: [`${path.basename(f)} 太大（${Math.round(st.size / 1048576)} MB，最多 ${P.MAX_VRM_BYTES / 1048576} MB）`] };
      const info = V.inspectVrmFile(abs);
      if (!info.ok) return { ok: false, errors: [`${path.basename(f)}：${info.errors.join('；')}`] };
      metas[f] = info.meta;
    }
    const first = map.outfits.daily || Object.values(map.outfits)[0];
    const meta = metas[first];
    const name = meta.name || path.basename(first).replace(/\.vrm$/i, '');
    // copied flat into models/ (same name twice in different folders keeps both)
    const target = {};
    const used = new Set();
    for (const f of Object.keys(metas)) {
      let base = path.basename(f).replace(/[^\w.\-]+/g, '_');
      if (!/\.vrm$/i.test(base)) base += '.vrm';
      for (let i = 2; used.has(base.toLowerCase()); i++) base = base.replace(/(-\d+)?\.vrm$/i, `-${i}.vrm`);
      used.add(base.toLowerCase());
      target[f] = `${VRM_DIR}/${base}`;
    }
    const outfits = Object.fromEntries(Object.entries(map.outfits).map(([id, f]) => [id, target[f]]));
    const manifest = P.vrmManifest({ speciesId, name, outfits, meta });
    const existing = packs.get(manifest.id);
    if (existing && existing.source === 'builtin') return { ok: false, errors: ['这个名字已被内置角色包占用'] };
    const dest = path.join(dest0, manifest.id);
    if (!inside(dest, dest0) || dest === dest0) return { ok: false, errors: ['bad pack id'] };
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.join(dest, VRM_DIR), { recursive: true });
    for (const [f, rel] of Object.entries(target)) fs.copyFileSync(path.join(root, f), path.join(dest, rel));
    fs.writeFileSync(path.join(dest, P.PREVIEW_FILE), BLANK_PNG);
    fs.writeFileSync(path.join(dest, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const r = P.readPack(dest);
    if (!r.ok) {
      fs.rmSync(dest, { recursive: true, force: true });
      return { ok: false, errors: r.errors };
    }
    return {
      ok: true,
      pack: { id: r.pack.id, name: r.pack.name, species: r.pack.species, dir: r.pack.dir },
      outfits: Object.keys(r.pack.outfits),
      license: r.pack.vrm.license,
      meta: r.pack.vrm.models[outfits.daily || Object.values(outfits)[0]].meta,
      replaced: !!existing,
    };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { VRM_DIR, APP_ROOT, findVrmFiles, mapVrmOutfits, importVrm, unzip };
