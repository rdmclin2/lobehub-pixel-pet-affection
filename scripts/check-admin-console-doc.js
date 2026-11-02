#!/usr/bin/env node
'use strict';
// Checks that docs/admin-console-design.md covers every settings.json key and every settings IPC channel.
//
//   node scripts/check-admin-console-doc.js            # exit 0 = every key is in the doc, 1 = something is missing
//   node scripts/check-admin-console-doc.js --write    # also rewrite §12 覆盖矩阵 from the code
//
// Keys come from the code, not from a hand-written list: normalizeSettings(null) (src/core/settings.js, which
// pulls in TTS_DEFAULTS and ASR_DEFAULTS) is flattened into dotted leaf paths (`prefs.roam`, `tts.local.api`, …).
// A path counts as covered when the doc names it in backticks (`prefs.roam`). Per-character maps that are empty
// by default (`appearance`, `models`, `systemRoles`, `framings`) are checked as `appearance.<id>` etc.
// The set-* / per-character channels registered in src/main/main.js must be named in the doc as well.
//
// 覆盖矩阵 (§12, src/core/admin-coverage.js): every user-configurable settings.json key has a schema field (or is
// an internal flag with a reason), every pet-window channel and menu item has its place in the settings window
// (or a reason it needs none), every runtime behaviour names the controls that steer it, and every bridge
// method is called by some page. §12 in the doc is generated from the same audit and must match it.

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSettings } = require('../src/core/settings');
const coverage = require('../src/core/admin-coverage');

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

// ---- §12 覆盖矩阵 --------------------------------------------------------------------------------------------
const audit = coverage.audit(coverage.collect(ROOT));
const matrix = coverage.renderMatrix(audit);
const START = '<!-- coverage-matrix:start';
const END = '<!-- coverage-matrix:end -->';
let text = doc;
if (process.argv.includes('--write')) {
  const i = text.indexOf(START);
  text = i < 0 ? `${text.trimEnd()}\n\n## 12. 覆盖矩阵（自动生成）\n\n${matrix}\n` : text.slice(0, i) + matrix + text.slice(text.indexOf(END) + END.length);
  fs.writeFileSync(DOC, text);
  console.log('wrote §12 覆盖矩阵 into docs/admin-console-design.md');
}
const docMatrix = text.includes(START) ? text.slice(text.indexOf(START), text.indexOf(END) + END.length) : '';
const stale = docMatrix !== matrix;
const count = (rows, st) => rows.filter((r) => r.status === st).length;
console.log(`\ncoverage matrix (src/core/admin-coverage.js):`);
console.log(`  settings.json leaves: ${audit.settings.length} (${count(audit.settings, 'ok')} in the console, ${count(audit.settings, 'internal')} internal, ${count(audit.settings, 'MISSING')} missing)`);
console.log(`  runtime behaviours:   ${audit.runtime.length} (${count(audit.runtime, 'ok')} controlled, ${count(audit.runtime, 'MISSING')} missing)`);
console.log(`  menu items:           ${audit.menu.length} (${count(audit.menu, 'ok')} in the console, ${count(audit.menu, 'n/a')} not settings, ${count(audit.menu, 'MISSING')} missing)`);
console.log(`  pet-window channels:  ${audit.channels.length} (${count(audit.channels, 'admin')} same channel, ${count(audit.channels, 'via')} via another, ${count(audit.channels, 'pet-only')} not settings, ${count(audit.channels, 'MISSING')} missing)`);
for (const p of audit.problems) console.log(`  MISS ${p}`);
console.log(`  §12 in the doc: ${!docMatrix ? 'MISSING' : stale ? 'STALE (run with --write)' : 'up to date'}`);

if (missingKeys.length || missingChannels.length || audit.problems.length || stale) {
  console.log(`\nFAIL: ${missingKeys.length} key(s) and ${missingChannels.length} channel(s) not named in the doc, ${audit.problems.length} coverage gap(s)${stale ? ', §12 out of date' : ''}`);
  process.exit(1);
}
console.log('\nPASS: every settings.json key and settings IPC channel is named in docs/admin-console-design.md, and the coverage matrix has no gaps');
