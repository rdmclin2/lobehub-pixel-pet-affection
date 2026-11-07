#!/usr/bin/env node
'use strict';

// Live2D 本地素材库校验 (live2d-library/README.md): walk live2d-library/models/<id>/, parse every *.model3.json
// (Cubism 3/4/5) and *.model.json (Cubism 2), check that every file a model references exists, read the moc version
// and texture sizes, count physics / expressions / motions, backfill what can be measured into
// live2d-library/manifest.json, and print a summary (total, downloadable, Cubism 3+, quality tiers A/B/C).
//
// The library is local-only and never part of the store: this script reads nothing under catalog/ unless it is
// pointed there with --sample, which is read-only (it never copies or writes).
//
//   node scripts/live2d-library-check.js                      # check the library and backfill manifest.json
//   node scripts/live2d-library-check.js --dry-run            # check only, leave manifest.json alone
//   node scripts/live2d-library-check.js --sample <dir>       # measure one model dir read-only (quality baseline)
//   node scripts/live2d-library-check.js --root <libDir>      # another library root (tests)
//   add --json for machine-readable output
//
// Exit code 1 when a manifest entry is malformed or a downloaded model has missing files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const CHANNELS = ['github', 'bilibili', 'forum', 'qq', 'steam-workshop', 'booth', 'nizima', 'official', 'other'];
const STATUSES = ['downloaded', 'failed', 'not-downloadable', 'login-required', 'paid', 'pending'];
const FLAGS = ['commercial', 'redistribute', 'modify', 'attribution', 'needsAuthorization'];
const CUBISM = [2, 3, 4, 5, 'unknown'];
const TIERS = ['A', 'B', 'C'];
// id prefix → channel, used for entries the script creates from a model dir that has no manifest row yet
const PREFIXES = { 'gh-': 'github', 'bili-': 'bilibili', 'forum-': 'forum', 'qq-': 'qq', 'steam-': 'steam-workshop', 'booth-': 'booth', 'nizima-': 'nizima', 'official-': 'official', 'other-': 'other' };
const ID_RE = /^(gh|bili|forum|qq|steam|booth|nizima|official|other)-[a-z0-9]+(-[a-z0-9]+)*$/;
const ARCHIVE_RE = /\.(zip|7z|rar|tar|tgz|tar\.gz)$/i;
// the fields a check run measures; everything else in an entry is written by hand (or by the download task)
const AUTO = ['cubismVersion', 'appSupported', 'files', 'hasPhysics', 'expressionCount', 'expressionParamCount', 'motionCount', 'textureMaxSize', 'sizeBytes', 'missingFiles', 'qualityTier'];

// moc3 header: "MOC3" then one version byte (Live2D Cubism Core csmMocVersion)
const MOC3_VERSIONS = { 1: { cubism: 3, label: '3.0' }, 2: { cubism: 3, label: '3.3' }, 3: { cubism: 4, label: '4.0' }, 4: { cubism: 4, label: '4.2' }, 5: { cubism: 5, label: '5.0' }, 6: { cubism: 5, label: '5.3' } };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function dirSize(dir) {
  return walk(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
}

// width/height of a PNG (IHDR) or JPEG (first SOFn); null when the file is not one of those
function imageSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.readUInt32BE(0) === 0x89504e47) return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = fs.readFileSync(file);
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable → unknown */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

function mocVersion(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    if (head.toString('latin1', 0, 4) !== 'MOC3') return null;
    return MOC3_VERSIONS[head[4]] || { cubism: head[4] > 6 ? 5 : 'unknown', label: `moc3 v${head[4]}` };
  } catch { return null; }
}

// parameters that drive expressions directly (大肥鱼 has no .exp3.json; its faces are PARAM_EXP* parameters)
function expressionParams(cdiFile) {
  try {
    const cdi = readJson(cdiFile);
    return (cdi.Parameters || []).filter((p) => /^PARAM_?EXP|^ParamExp|expression/i.test(p.Id || '') || /表情/.test(p.Name || '')).length;
  } catch { return 0; }
}

// one model file → what it references and what it measures
function analyzeModel(file) {
  const dir = path.dirname(file);
  const res = { file, cubismVersion: 'unknown', mocLabel: null, hasPhysics: false, expressionCount: 0, expressionParamCount: 0, motionCount: 0, textureMaxSize: 0, textures: [], missingFiles: [], error: null };
  let j;
  try { j = readJson(file); } catch (e) { res.error = `unparseable JSON: ${e.message}`; return res; }
  const refs = [];
  const ref = (rel, role) => { if (typeof rel === 'string' && rel) refs.push({ rel, role }); };
  if (/\.model3\.json$/i.test(file)) {
    const fr = j.FileReferences || {};
    ref(fr.Moc, 'moc');
    for (const t of fr.Textures || []) ref(t, 'texture');
    ref(fr.Physics, 'physics');
    ref(fr.Pose, 'pose');
    ref(fr.DisplayInfo, 'cdi');
    ref(fr.UserData, 'userdata');
    for (const x of fr.Expressions || []) ref(x && x.File, 'expression');
    for (const group of Object.values(fr.Motions || {})) for (const m of group || []) { ref(m && m.File, 'motion'); ref(m && m.Sound, 'sound'); }
    if (!fr.Moc) res.error = 'no FileReferences.Moc';
    res.hasPhysics = !!fr.Physics;
    res.expressionCount = (fr.Expressions || []).length;
    res.motionCount = Object.values(fr.Motions || {}).reduce((n, g) => n + (g || []).length, 0);
    const moc = fr.Moc && mocVersion(path.join(dir, fr.Moc));
    if (moc) { res.cubismVersion = moc.cubism; res.mocLabel = moc.label; }
    if (fr.DisplayInfo) res.expressionParamCount = expressionParams(path.join(dir, fr.DisplayInfo));
  } else {
    // Cubism 2 (.model.json)
    ref(j.model, 'moc');
    for (const t of j.textures || []) ref(t, 'texture');
    ref(j.physics, 'physics');
    ref(j.pose, 'pose');
    for (const x of j.expressions || []) ref(x && x.file, 'expression');
    for (const group of Object.values(j.motions || {})) for (const m of group || []) { ref(m && m.file, 'motion'); ref(m && m.sound, 'sound'); }
    if (!j.model) res.error = 'no "model" (.moc) reference';
    res.cubismVersion = 2;
    res.mocLabel = '2.x';
    res.hasPhysics = !!j.physics;
    res.expressionCount = (j.expressions || []).length;
    res.motionCount = Object.values(j.motions || {}).reduce((n, g) => n + (g || []).length, 0);
  }
  for (const r of refs) {
    const abs = path.join(dir, r.rel);
    if (!fs.existsSync(abs)) { res.missingFiles.push(path.relative(dir, abs)); continue; }
    if (r.role === 'texture') {
      const s = imageSize(abs);
      res.textures.push({ file: r.rel, ...(s || {}) });
      if (s) res.textureMaxSize = Math.max(res.textureMaxSize, s.w, s.h);
    }
  }
  return res;
}

// A = 接近大肥鱼: Cubism 4+, physics, ≥2K texture, expressions (.exp3.json or expression parameters)
// B = runs in the app (Cubism 3+) but misses part of A; C = Cubism 2 / unknown / broken
function tierOf(m) {
  const cub = typeof m.cubismVersion === 'number' ? m.cubismVersion : 0;
  if (m.missingFiles.length || cub < 3) return 'C';
  const hasExpr = m.expressionCount > 0 || m.expressionParamCount > 0;
  if (cub >= 4 && m.hasPhysics && m.textureMaxSize >= 2048 && hasExpr) return 'A';
  return 'B';
}

// a model dir (one library entry, maybe several model files) → the entry's measurable fields
function analyzeDir(dir) {
  const files = walk(dir).filter((f) => /\.model3?\.json$/i.test(f));
  const models = files.map(analyzeModel);
  const num = (k) => models.reduce((n, m) => Math.max(n, m[k]), 0);
  const cubs = models.map((m) => m.cubismVersion).filter((v) => typeof v === 'number');
  const agg = {
    cubismVersion: cubs.length ? Math.max(...cubs) : 'unknown',
    files: files.map((f) => path.relative(dir, f).split(path.sep).join('/')),
    hasPhysics: models.some((m) => m.hasPhysics),
    expressionCount: num('expressionCount'),
    expressionParamCount: num('expressionParamCount'),
    motionCount: num('motionCount'),
    textureMaxSize: num('textureMaxSize'),
    sizeBytes: dirSize(dir),
    missingFiles: models.flatMap((m) => m.missingFiles.map((f) => `${path.relative(dir, path.dirname(m.file)).split(path.sep).join('/') || '.'}/${f}`.replace(/^\.\//, ''))),
  };
  agg.appSupported = typeof agg.cubismVersion === 'number' && agg.cubismVersion >= 3;
  // the best model in the dir sets the tier (variants of one character usually share textures and physics)
  agg.qualityTier = models.length ? models.map(tierOf).sort()[0] : 'C';
  const errors = models.filter((m) => m.error).map((m) => `${path.relative(dir, m.file)}: ${m.error}`);
  if (!models.length) errors.push('no *.model3.json / *.model.json found');
  return { agg, models, errors };
}

function blankEntry(id) {
  const prefix = Object.keys(PREFIXES).find((p) => id.startsWith(p));
  return {
    id, name: id, channel: prefix ? PREFIXES[prefix] : 'other', sourceUrl: '', author: '',
    downloadStatus: 'downloaded', failReason: null,
    license: 'unknown', licenseNote: '',
    licenseFlags: { commercial: 'unknown', redistribute: 'unknown', modify: 'unknown', attribution: 'unknown', needsAuthorization: 'unknown' },
    cubismVersion: 'unknown', appSupported: false, files: [], hasPhysics: false, expressionCount: 0, expressionParamCount: 0, motionCount: 0,
    textureMaxSize: 0, sizeBytes: 0, sha256: null, qualityTier: 'C', previewPath: null, notes: '',
  };
}

// schema problems in one manifest entry (hand-written fields included)
function validateEntry(e) {
  const p = [];
  const at = (msg) => p.push(`${e.id || '(no id)'}: ${msg}`);
  if (!e.id || !ID_RE.test(e.id)) at(`id must be kebab-case with a source prefix (${Object.keys(PREFIXES).join(' ')})`);
  if (!e.name) at('name is empty');
  if (!CHANNELS.includes(e.channel)) at(`channel "${e.channel}" not in ${CHANNELS.join('|')}`);
  if (!STATUSES.includes(e.downloadStatus)) at(`downloadStatus "${e.downloadStatus}" not in ${STATUSES.join('|')}`);
  if (e.downloadStatus !== 'downloaded' && e.downloadStatus !== 'pending' && !e.failReason) at(`downloadStatus ${e.downloadStatus} needs a failReason`);
  if (typeof e.sourceUrl !== 'string' || (e.sourceUrl && !/^https?:\/\//.test(e.sourceUrl))) at('sourceUrl must be an http(s) URL');
  if (!e.license) at('license is empty (use "unknown" when it is not known)');
  const f = e.licenseFlags || {};
  for (const k of FLAGS) if (!(f[k] === true || f[k] === false || f[k] === 'unknown')) at(`licenseFlags.${k} must be true | false | "unknown"`);
  if (!CUBISM.includes(e.cubismVersion)) at(`cubismVersion "${e.cubismVersion}" not in 2|3|4|5|unknown`);
  if (e.qualityTier != null && !TIERS.includes(e.qualityTier)) at(`qualityTier "${e.qualityTier}" not in A|B|C`);
  if (e.sha256 != null && !/^[0-9a-f]{64}$/.test(e.sha256)) at('sha256 must be 64 hex chars or null');
  if (e.previewPath && (path.isAbsolute(e.previewPath) || e.previewPath.includes('..'))) at('previewPath must be relative to live2d-library/');
  return p;
}

function checkLibrary(lib, { write }) {
  const manifestFile = path.join(lib, 'manifest.json');
  const modelsDir = path.join(lib, 'models');
  const downloads = path.join(lib, '_downloads');
  const manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : { schema: 1, entries: [] };
  manifest.entries = manifest.entries || [];
  const problems = [];
  const warnings = [];
  const byId = new Map();
  for (const e of manifest.entries) {
    if (byId.has(e.id)) problems.push(`${e.id}: duplicate id in manifest.json`);
    byId.set(e.id, e);
  }
  const dirs = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const archives = fs.existsSync(downloads) ? fs.readdirSync(downloads).filter((f) => ARCHIVE_RE.test(f)) : [];
  const details = {};
  for (const id of dirs) {
    let e = byId.get(id);
    if (!e) { e = blankEntry(id); manifest.entries.push(e); byId.set(id, e); warnings.push(`${id}: model dir had no manifest entry, created one (fill in source and license)`); }
    const { agg, models, errors } = analyzeDir(path.join(modelsDir, id));
    details[id] = models;
    for (const err of errors) problems.push(`${id}: ${err}`);
    for (const m of agg.missingFiles) problems.push(`${id}: missing referenced file ${m}`);
    for (const k of AUTO) if (!(k === 'qualityTier' && e.qualityTierManual)) e[k] = agg[k];
    if (e.downloadStatus !== 'downloaded') { warnings.push(`${id}: model dir exists, downloadStatus ${e.downloadStatus} → downloaded`); e.downloadStatus = 'downloaded'; e.failReason = null; }
    const archive = archives.find((f) => f.replace(ARCHIVE_RE, '') === id);
    if (archive) e.sha256 = sha256(path.join(downloads, archive));
    if (!e.previewPath) {
      const pv = ['previews', 'models/' + id].map((d) => ['preview.png', `${id}.png`, 'preview.jpg', `${id}.jpg`].map((f) => `${d}/${f}`)).flat().find((rel) => fs.existsSync(path.join(lib, rel)));
      if (pv) e.previewPath = pv;
    }
  }
  for (const e of manifest.entries) {
    problems.push(...validateEntry(e));
    if (e.downloadStatus === 'downloaded' && !dirs.includes(e.id)) problems.push(`${e.id}: downloadStatus downloaded but models/${e.id}/ is missing`);
    if (e.licenseFlags && e.licenseFlags.needsAuthorization !== false && e.downloadStatus === 'downloaded') warnings.push(`${e.id}: needsAuthorization is ${e.licenseFlags.needsAuthorization}; personal/local use only until cleared`);
  }
  manifest.entries.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  manifest.updatedAt = new Date().toISOString().slice(0, 10);
  if (write) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, problems, warnings, details };
}

function summarize(entries) {
  const s = { total: entries.length, downloaded: 0, downloadable: 0, cubism3plus: 0, tiers: { A: 0, B: 0, C: 0 }, byStatus: {}, byChannel: {}, needsAuthorization: 0 };
  for (const e of entries) {
    s.byStatus[e.downloadStatus] = (s.byStatus[e.downloadStatus] || 0) + 1;
    s.byChannel[e.channel] = (s.byChannel[e.channel] || 0) + 1;
    if (e.downloadStatus === 'downloaded') s.downloaded++;
    // downloadable: got it, or it can be fetched without paying / logging in once someone retries
    if (['downloaded', 'pending', 'failed'].includes(e.downloadStatus)) s.downloadable++;
    if (typeof e.cubismVersion === 'number' && e.cubismVersion >= 3) s.cubism3plus++;
    if (e.downloadStatus === 'downloaded' && TIERS.includes(e.qualityTier)) s.tiers[e.qualityTier]++;
    if (e.licenseFlags && e.licenseFlags.needsAuthorization !== false) s.needsAuthorization++;
  }
  return s;
}

function printModels(models, base) {
  for (const m of models) {
    console.log(`  ${path.relative(base, m.file)}  Cubism ${m.cubismVersion}${m.mocLabel ? ` (moc ${m.mocLabel})` : ''}`);
    console.log(`    physics ${m.hasPhysics ? 'yes' : 'no'} · expressions ${m.expressionCount} (.exp3) + ${m.expressionParamCount} (params) · motions ${m.motionCount} · textures ${m.textures.map((t) => (t.w ? `${t.w}×${t.h}` : '?')).join(', ') || 'none'} · tier ${tierOf(m)}`);
    if (m.missingFiles.length) console.log(`    MISSING: ${m.missingFiles.join(', ')}`);
    if (m.error) console.log(`    ERROR: ${m.error}`);
  }
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const json = argv.includes('--json');
  const sample = arg('--sample');
  if (sample) {
    const dir = path.resolve(sample);
    if (!fs.existsSync(dir)) { console.error(`no such dir: ${dir}`); return 2; }
    const { agg, models, errors } = analyzeDir(dir);
    if (json) console.log(JSON.stringify({ sample: dir, ...agg, errors }, null, 2));
    else {
      console.log(`sample (read-only): ${path.relative(process.cwd(), dir) || dir}`);
      printModels(models, dir);
      console.log(`  → cubismVersion ${agg.cubismVersion} · appSupported ${agg.appSupported} · hasPhysics ${agg.hasPhysics} · expressionCount ${agg.expressionCount} · expressionParamCount ${agg.expressionParamCount} · motionCount ${agg.motionCount} · textureMaxSize ${agg.textureMaxSize} · sizeBytes ${agg.sizeBytes} · qualityTier ${agg.qualityTier}`);
      for (const e of errors) console.log(`  ERROR: ${e}`);
    }
    return errors.length || agg.missingFiles.length ? 1 : 0;
  }
  const lib = path.resolve(arg('--root') || path.join(ROOT, 'live2d-library'));
  const write = !argv.includes('--dry-run');
  const { manifest, problems, warnings, details } = checkLibrary(lib, { write });
  const s = summarize(manifest.entries);
  if (json) { console.log(JSON.stringify({ library: lib, summary: s, problems, warnings }, null, 2)); return problems.length ? 1 : 0; }
  console.log(`Live2D library: ${lib}${write ? '' : ' (dry run, manifest.json not written)'}`);
  for (const [id, models] of Object.entries(details)) { console.log(`\n${id}`); printModels(models, path.join(lib, 'models', id)); }
  console.log(`\nentries ${s.total} · downloaded ${s.downloaded} · downloadable ${s.downloadable} · Cubism 3+ ${s.cubism3plus} · tiers A ${s.tiers.A} / B ${s.tiers.B} / C ${s.tiers.C} · needs authorization ${s.needsAuthorization}`);
  if (Object.keys(s.byStatus).length) console.log(`status: ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (Object.keys(s.byChannel).length) console.log(`channel: ${Object.entries(s.byChannel).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const w of warnings) console.log(`warn: ${w}`);
  for (const p of problems) console.log(`FAIL: ${p}`);
  console.log(problems.length ? `\n${problems.length} problem(s)` : '\nok');
  return problems.length ? 1 : 0;
}

module.exports = { analyzeModel, analyzeDir, checkLibrary, summarize, tierOf, validateEntry, imageSize, mocVersion };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
