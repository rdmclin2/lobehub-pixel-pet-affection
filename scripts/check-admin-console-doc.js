#!/usr/bin/env node
'use strict';
// Checks that docs/admin-console-design.md covers every settings.json key and every settings IPC channel.
//
//   node scripts/check-admin-console-doc.js            # exit 0 = every key is in the doc, 1 = something is missing
//
// Keys come from the code, not from a hand-written list: normalizeSettings(null) (src/core/settings.js, which
// pulls in TTS_DEFAULTS and ASR_DEFAULTS) is flattened into dotted leaf paths (`prefs.roam`, `tts.local.api`, …).
// A path counts as covered when the doc names it in backticks (`prefs.roam`). Per-character maps that are empty
// by default (`appearance`, `models`, `systemRoles`, `framings`) are checked as `appearance.<id>` etc.
// The set-* / per-character channels registered in src/main/main.js must be named in the doc as well.

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSettings } = require('../src/core/settings');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'admin-console-design.md');
const PER_CHARACTER = ['appearance', 'models', 'systemRoles', 'framings'];

function leaves(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (PER_CHARACTER.includes(p)) out.push(`${p}.<id>`);
    else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out.push(...leaves(v, p));
    else out.push(p);
  }
  return out;
}

const keys = leaves(normalizeSettings(null));
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
const channels = [...main.matchAll(/ipcMain\.(?:handle|on)\('((?:set|import|remove|export|unlock|switch|equip|refresh|tts|voicepacks|asr|api|confirm)-[a-z0-9-]*|open-voicepacks-folder|open-packs-folder)'/g)].map((m) => m[1]);
const doc = fs.readFileSync(DOC, 'utf8');
const named = new Set([...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()));

const missingKeys = keys.filter((k) => !named.has(k));
const missingChannels = [...new Set(channels)].filter((c) => !named.has(c));

console.log(`settings.json leaf keys from normalizeSettings(null): ${keys.length}`);
for (const k of keys) console.log(`  ${named.has(k) ? 'ok  ' : 'MISS'} ${k}`);
console.log(`settings / roster IPC channels in src/main/main.js: ${new Set(channels).size}`);
for (const c of new Set(channels)) console.log(`  ${named.has(c) ? 'ok  ' : 'MISS'} ${c}`);
if (missingKeys.length || missingChannels.length) {
  console.log(`\nFAIL: ${missingKeys.length} key(s) and ${missingChannels.length} channel(s) are not named in docs/admin-console-design.md`);
  process.exit(1);
}
console.log('\nPASS: every settings.json key and settings IPC channel is named in docs/admin-console-design.md');
