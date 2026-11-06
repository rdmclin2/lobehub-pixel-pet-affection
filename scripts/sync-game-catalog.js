#!/usr/bin/env node
'use strict';

// 商店 → 小游戏 (docs/mini-games.md §7): the store's games ship with the app as src/core/game-catalog.json — a
// copy of the published entries of the games repository's catalog.json (rdmclin2/pixel-pet-mini-games), with
// each cover picture downloaded to src/renderer/catalog/games/<id>.webp and its screenshots to
// src/renderer/catalog/games/<id>/, so the store shows them offline. The
// app also reads the repository's catalog.json itself now and then (core/game-index.js), so a game published
// after a release still shows up; run this before a release so the bundled copy is current.
//
//   node scripts/sync-game-catalog.js [--from <catalog.json path or URL>] [--repo <games checkout>] [--all] [--check]
//
// --check: fail when the bundled copy differs from the repository's (published entries only).
// --repo <dir>: a local checkout of the games repository: its catalog.json (unless --from says otherwise), and
//   cover / screenshot URLs on its main branch (raw.githubusercontent.com/…/main/<path>) read from <dir>/<path>,
//   so a game that is built but not pushed yet can be tried (docs/pixel-room.md「试玩」).
// --all: also entries that are not published yet (no `published`: not on the CDN) — local trials only, never
//   commit the result.
const fs = require('node:fs');
const path = require('node:path');
const GI = require('../src/core/game-index');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const REPO = arg('--repo', null) && path.resolve(arg('--repo', null));
const FROM = arg('--from', REPO ? path.join(REPO, 'catalog.json') : GI.REMOTE_URL);
const CHECK = process.argv.includes('--check');
const ALL = process.argv.includes('--all');
const RAW_MAIN = 'https://raw.githubusercontent.com/rdmclin2/pixel-pet-mini-games/main/';
const PICS = path.join(ROOT, 'src', 'renderer', 'catalog', 'games');

async function read(src) {
  if (/^https:\/\//.test(src)) { const r = await fetch(src); if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`); return r.json(); }
  return JSON.parse(fs.readFileSync(src, 'utf8'));
}

// a picture: from the local checkout when --repo is given and the URL is on its main branch, else downloaded
async function bytes(url, what) {
  if (REPO && url.startsWith(RAW_MAIN)) {
    const f = path.join(REPO, ...url.slice(RAW_MAIN.length).split('/'));
    if (!fs.existsSync(f)) throw new Error(`${what}: ${f} is missing`);
    return fs.readFileSync(f);
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${what}: ${url} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const raw = await read(FROM);
  if (ALL && CHECK) throw new Error('--all is for local trials; --check compares published entries only');
  const pick = (raw.games || []).filter((g) => g.published || (ALL && g.file && g.sha256));
  for (const g of pick) if (!g.published) console.log(`  ${g.id} ${g.version}: not published yet (--all) — a local trial, do not commit`);
  const remote = GI.parseIndex({ ...raw, games: pick });
  const games = [];
  for (const g of remote.games) {
    let picture = null;
    if (g.picture) {
      const file = path.join(PICS, `${g.id}.webp`);
      if (!CHECK) {
        const buf = await bytes(g.picture, `${g.id}: cover`);
        fs.mkdirSync(PICS, { recursive: true });
        fs.writeFileSync(file, buf);
      }
      picture = `catalog/games/${g.id}.webp`;
    }
    // the detail page's screenshots: src/renderer/catalog/games/<id>/<file>
    const screenshots = [];
    if (!CHECK) fs.rmSync(path.join(PICS, g.id), { recursive: true, force: true });
    for (const s of g.screenshots) {
      const name = path.basename(s.url);
      if (!CHECK) {
        const buf = await bytes(s.url, `${g.id}: screenshot`);
        fs.mkdirSync(path.join(PICS, g.id), { recursive: true });
        fs.writeFileSync(path.join(PICS, g.id, name), buf);
      }
      screenshots.push({ url: `catalog/games/${g.id}/${name}`, caption: s.caption });
    }
    const { source: _s, bundledPicture: _b, release: _r, ...entry } = g;
    games.push({ ...entry, picture, screenshots });
    console.log(`  ${g.id} ${g.version}  ${g.file}  ${g.bytes} bytes`);
  }
  const text = `${JSON.stringify({ schema: 1, release: remote.release, games }, null, 2)}\n`;
  if (CHECK) {
    const now = fs.readFileSync(GI.BUNDLED_FILE, 'utf8');
    if (now !== text) { console.error('src/core/game-catalog.json is not the published catalog (run node scripts/sync-game-catalog.js)'); process.exit(1); }
    console.log('src/core/game-catalog.json matches the published catalog');
    return;
  }
  fs.writeFileSync(GI.BUNDLED_FILE, text);
  console.log(`${games.length} game(s) → src/core/game-catalog.json`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
