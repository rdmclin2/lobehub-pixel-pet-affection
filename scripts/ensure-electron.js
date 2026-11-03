#!/usr/bin/env node
// postinstall: make sure node_modules/electron/dist (the Electron binary) is there after `npm install` / `npm ci`.
//
// Since npm 11 a dependency's install scripts only run when package.json `allowScripts` lists it, and the
// electron package downloads its binary lazily (on the first `require('electron')`). Either way `npm ci` can end
// with node_modules/electron/dist missing, and the first `npm start` / e2e run then downloads it in the middle of
// launching (or fails behind a proxy). This script runs Electron's own installer once, right after the install,
// the same as `node node_modules/electron/install.js` by hand (README → 安装与运行).
//
// Never fails the install: without network it says what to run later and exits 0. Skipped when
// ELECTRON_SKIP_BINARY_DOWNLOAD is set (CI that brings its own Electron).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'node_modules', 'electron');
const installer = path.join(dir, 'install.js');

function binary() {
  const pathFile = path.join(dir, 'path.txt');
  if (!fs.existsSync(pathFile)) return null;
  const p = path.join(dir, 'dist', fs.readFileSync(pathFile, 'utf8').trim());
  return fs.existsSync(p) ? p : null;
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(0);
if (!fs.existsSync(installer)) process.exit(0); // installed without devDependencies (--omit=dev)
if (binary()) process.exit(0);

console.log('[ensure-electron] node_modules/electron/dist is missing: running node node_modules/electron/install.js');
const r = spawnSync(process.execPath, [installer], { cwd: dir, stdio: 'inherit' });
if (r.status === 0 && binary()) {
  console.log('[ensure-electron] Electron is ready.');
} else {
  console.warn('[ensure-electron] Could not download Electron now. Run `node node_modules/electron/install.js` once you are online (README → 安装与运行).');
}
process.exit(0);
