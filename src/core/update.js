'use strict';

// Electron-free pieces of the self-updater (src/main/updater.js). Releases are GitHub Releases of this
// repository; electron-builder writes `latest.yml` (Windows) and `latest-mac.yml` (macOS) next to them.
//
// macOS builds are not signed with an Apple Developer ID, so Squirrel.Mac (electron-updater's mac path)
// refuses them. On macOS the app therefore updates itself: download the release zip, check its sha512,
// unpack it next to the running app and, once the app has quit, swap the bundles with a small script.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const REPO = 'rdmclin2/lobehub-pixel-pet-affection';
const LATEST_URL = (file) => `https://github.com/${REPO}/releases/latest/download/${file}`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// The subset of electron-builder's update info we use:
//   version: 0.4.1
//   files:
//     - url: PixelPetAffection-0.4.1-mac-universal.zip
//       sha512: <base64>
//       size: 123
function parseUpdateInfo(text) {
  const info = { version: null, files: [] };
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const top = /^(\w+):\s*(.*)$/.exec(raw);
    if (top) {
      cur = null;
      if (top[1] === 'version') info.version = unquote(top[2]);
      continue;
    }
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(raw);
    if (item) {
      cur = {};
      info.files.push(cur);
      cur[item[1]] = unquote(item[2]);
      continue;
    }
    const field = /^\s+(\w+):\s*(.*)$/.exec(raw);
    if (field && cur) cur[field[1]] = unquote(field[2]);
  }
  for (const f of info.files) if (f.size !== undefined) f.size = Number(f.size);
  return info;
}

const unquote = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2');

// Release versions are plain x.y.z; anything after a "-" (a pre-release) sorts below the release.
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre || null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const isNewer = (candidate, current) => !!candidate && compareVersions(candidate, current) > 0;

const macZip = (info) => info.files.find((f) => /-mac-[\w]+\.zip$/.test(f.url || '')) || null;

function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('base64')));
  });
}

// The .app bundle the running binary belongs to, or null when it cannot replace itself: started from
// the DMG, from a translocated copy (Gatekeeper runs apps opened from Downloads from a random read-only
// path), or from a folder the user cannot write.
function macAppPath(execPath, { access = fs.accessSync } = {}) {
  const app = path.resolve(execPath, '..', '..', '..');
  if (!app.endsWith('.app')) return { app: null, reason: 'not-bundle' };
  if (app.includes('/AppTranslocation/')) return { app: null, reason: 'translocated' };
  if (app.startsWith('/Volumes/')) return { app: null, reason: 'dmg' };
  try {
    access(path.dirname(app), fs.constants.W_OK);
    access(app, fs.constants.W_OK);
  } catch {
    return { app: null, reason: 'read-only' };
  }
  return { app, reason: null };
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, stdout, stderr) => (e ? reject(new Error(`${cmd} failed: ${String(stderr || e.message).trim().slice(0, 200)}`)) : resolve(stdout))));

// Unpack the downloaded zip into `stageDir` and return the .app inside it. `ditto` keeps the bundle's
// symlinks, permissions and signature intact (plain unzip does not).
async function stageMacApp({ zip, stageDir, appName, extract = (z, d) => run('/usr/bin/ditto', ['-x', '-k', z, d]) }) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  await extract(zip, stageDir);
  const staged = path.join(stageDir, appName);
  if (!fs.existsSync(path.join(staged, 'Contents', 'Info.plist'))) throw new Error(`the update does not contain ${appName}`);
  return staged;
}

// Waits for the app (pid) to exit, swaps the bundles (rolling back if the swap fails), clears the
// quarantine flag and optionally reopens the app. Arguments: pid, current .app, staged .app, relaunch (0|1).
const SWAP_SCRIPT = `#!/bin/bash
PID="$1"; OLD="$2"; NEW="$3"; RELAUNCH="$4"
for _ in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
BAK="$OLD.update-old"
rm -rf "$BAK"
if mv "$OLD" "$BAK"; then
  if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else mv "$BAK" "$OLD"; fi
fi
rmdir "$(dirname "$NEW")" 2>/dev/null || true
xattr -cr "$OLD" 2>/dev/null || true
if [ "$RELAUNCH" = 1 ]; then open "$OLD"; fi
`;

function writeSwapScript(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'swap-app.sh');
  fs.writeFileSync(file, SWAP_SCRIPT, { mode: 0o755 });
  return file;
}

module.exports = { REPO, LATEST_URL, RELEASES_API, parseUpdateInfo, compareVersions, isNewer, macZip, sha512Base64, macAppPath, stageMacApp, writeSwapScript, SWAP_SCRIPT };
