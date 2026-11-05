#!/usr/bin/env node
'use strict';

// 小游戏的包不在这个仓库里（源码在 rdmclin2/pixel-pet-mini-games）。开发和测试要用时，从 CDN 下载
// src/core/game-catalog.json 列出的安装包，按大小和 sha256 校验：
//   node scripts/fetch-game-packs.js                 → catalog/games/<id>/（解压，PIXELPET_DEV_GAMES=1 时应用直接读这里）
//   node scripts/fetch-game-packs.js --zips <dir>    → <dir>/<file>.zip（e2e 的本地「CDN」）
// 已经下载过、校验对得上的跳过。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const GI = require('../src/core/game-index');
const Catalog = require('../src/core/catalog');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const ZIPS = arg('--zips', null);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function main() {
  const dir = ZIPS ? path.resolve(ZIPS) : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pp-games-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const g of GI.loadBundled().games) {
    const zip = path.join(dir, g.file);
    const good = fs.existsSync(zip) && sha(fs.readFileSync(zip)) === g.sha256;
    if (!good) {
      const url = Catalog.downloadUrl(g, {}, {});
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${g.file}: HTTP ${r.status} (${url})`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== g.bytes || sha(buf) !== g.sha256) throw new Error(`${g.file}: ${buf.length} bytes, sha256 ${sha(buf).slice(0, 12)} — not what the index says`);
      fs.writeFileSync(zip, buf);
    }
    if (!ZIPS) {
      const dest = path.join(ROOT, 'catalog', 'games', g.id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      execFileSync('unzip', ['-q', '-o', zip, '-d', dest]);
    }
    console.log(`  ${g.id} ${g.version}  ${good ? 'already here' : 'downloaded'}${ZIPS ? `  ${zip}` : `  → catalog/games/${g.id}`}`);
  }
  if (!ZIPS) fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
