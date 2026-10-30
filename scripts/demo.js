#!/usr/bin/env node
'use strict';
// Offline demo: start the real app straight on a hatched pet, without a LobeHub login.
//   npm run demo                                  # desktop
//   xvfb-run -a npm run demo                      # Linux without a display
//   npm run demo -- --character gpt --fresh       # another character / start over
// It uses the fake `lh` from the tests (no network, no real agent; chat replies are `echo: …`) and its
// own data folder, so the real save is never touched. The first run hatches the pet through PetService,
// the same code the 唤醒 button runs; later runs reuse that save.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FAKE_LH = path.join(ROOT, 'test', 'fixtures', 'fake-lh.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

async function seed({ dataDir, fakeDir, speciesId, name }) {
  // the 18+ question already answered as "all ages", like an existing user
  const settingsFile = path.join(dataDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  if (fs.existsSync(path.join(dataDir, 'pet.json'))) return false;
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { LhClient, cleanEnv } = require('../src/core/lh-client');
  const { Store } = require('../src/core/store');
  const { SettingsStore } = require('../src/core/settings');
  const { PetService } = require('../src/main/pet-service');
  const svc = new PetService({ lh: new LhClient({ bin: FAKE_LH, env: { ...cleanEnv(), FAKE_LH_DIR: fakeDir } }), store: new Store(dataDir), settingsStore: new SettingsStore(dataDir) });
  svc.on('error', () => {});
  await svc.hatch({ speciesId, name });
  return true;
}

async function main() {
  const dataDir = path.resolve(arg('data', path.join(os.tmpdir(), 'pixel-pet-demo')));
  const fakeDir = path.join(dataDir, 'fake-lh');
  if (process.argv.includes('--fresh')) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(fakeDir, { recursive: true });
  const speciesId = arg('character', 'claude');
  const hatched = await seed({ dataDir, fakeDir, speciesId, name: arg('name', '') });
  console.log(`[demo] data: ${dataDir} (${hatched ? `hatched ${speciesId}` : 'existing save'}); lh: fake (offline)`);

  const electron = require('electron');
  // Linux from source: chrome-sandbox is not setuid root in node_modules, so Chromium refuses to start
  // with its sandbox (see docs/usage.md, 运行). The demo runs without it; `npm start` keeps it.
  const args = ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
  const env = { ...process.env, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_DATA_DIR: dataDir };
  const child = spawn(electron, args, { cwd: ROOT, env, stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code, signal) => process.exit(code === null ? (signal === 'SIGTERM' ? 0 : 1) : code));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { seed, FAKE_LH };
