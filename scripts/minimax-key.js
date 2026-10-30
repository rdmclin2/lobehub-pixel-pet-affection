'use strict';
// The MiniMax key for scripts/voicepack-generate.js, never printed: $MINIMAX_API_KEY, else an
// `export MINIMAX_API_KEY=…` line in ~/.config/pixel-pet/minimax.env, ~/.zshrc or ~/.bashrc
// (the owner's machine runs bash, so a key put in .zshrc is not in the environment).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILES = [path.join(os.homedir(), '.config', 'pixel-pet', 'minimax.env'), path.join(os.homedir(), '.zshrc'), path.join(os.homedir(), '.bashrc')];

function fromFile(file, name) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  let value = '';
  for (const line of text.split('\n')) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
    if (m) value = m[1].trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return value;
}

function read(name) {
  if (process.env[name]) return { value: process.env[name], from: 'env' };
  for (const f of FILES) { const v = fromFile(f, name); if (v) return { value: v, from: f }; }
  return { value: '', from: null };
}

module.exports = { key: () => read('MINIMAX_API_KEY'), endpoint: () => read('MINIMAX_ENDPOINT').value || 'https://api.minimax.cn' };

if (require.main === module) {
  const k = module.exports.key();
  console.log(k.value ? `key: found in ${k.from} (${k.value.length} chars)` : 'key: not found');
  console.log(`endpoint: ${module.exports.endpoint()}`);
}
