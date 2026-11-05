#!/usr/bin/env node
'use strict';

// 商店 → 小游戏 (docs/mini-games.md §7–§8): turn each game pack in catalog/games/<id>/ (manifest.json + its
// pictures, core/game-pack.js) into what the app and the download host need:
//   out/game-catalog/<id>.zip              one archive per game: the folder's files at the top level
//   src/core/game-catalog.json             the index the app ships: name, description, features, size, sha256 …
//   src/renderer/catalog/games/<id>.webp   the store card's picture (a screenshot: e2e/run.js gamedocs writes it)
//
//   node scripts/build-game-packs.js [--out <dir>] [--check]
//
// The archives are reproducible (sorted entries, fixed timestamps — build-character-catalog.js zip), so --check
// rebuilds them and fails when one differs from the index. Upload with `npm run catalog:upload -- --games` to the
// release named in the index (games-v1); a changed game needs a new version and a new release.

const fs = require('node:fs');
const path = require('node:path');
const GS = require('../src/core/game-store');
const { zip, sha256 } = require('./build-character-catalog');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'catalog', 'games');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'game-catalog')));
const CHECK = process.argv.includes('--check');
const INDEX = path.join(ROOT, 'src', 'core', 'game-catalog.json');
const RELEASE = 'games-v1';
// what the store card lists under the description (the manifest has no such field: it is store copy)
const FEATURES = {
  'pixel-yard': ['昼夜四时段 · 一天 24 分钟', '晴 / 多云 / 小雨 / 雷雨 / 雪 / 雾', '种菜、摘浆果、抓萤火虫', '每天三件小事，完成加好感'],
};

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ids = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const old = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { games: [] };
  const games = [];
  for (const id of ids) {
    const dir = path.join(SRC, id);
    const bad = GS.checkFolder(dir, id);
    if (bad) throw new Error(`${id}: ${bad.reason} ${bad.errors.join('; ')}`);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const file = path.join(OUT, `${id}.zip`);
    zip(dir, file);
    const entry = {
      id, type: 'game', name: m.name, version: m.version, description: m.description || '', credit: m.credit || '',
      features: FEATURES[id] || [],
      picture: fs.existsSync(path.join(ROOT, 'src', 'renderer', 'catalog', 'games', `${id}.webp`)) ? `catalog/games/${id}.webp` : null,
      file: `${id}.zip`, bytes: fs.statSync(file).size, sha256: sha256(file),
    };
    if (CHECK) {
      const was = (old.games || []).find((g) => g.id === id);
      if (!was || was.sha256 !== entry.sha256 || was.bytes !== entry.bytes) throw new Error(`${id}: the archive does not match src/core/game-catalog.json (run node scripts/build-game-packs.js)`);
    }
    games.push(entry);
    console.log(`  ${id}  ${m.version}  ${entry.bytes} bytes  ${entry.sha256.slice(0, 12)}`);
  }
  if (CHECK) { console.log(`${games.length} archives match the index → ${OUT}`); return; }
  fs.writeFileSync(INDEX, `${JSON.stringify({ schema: 1, release: RELEASE, games }, null, 2)}\n`);
  console.log(`${games.length} games → ${path.relative(ROOT, INDEX)}, archives in ${OUT}`);
}

main();
