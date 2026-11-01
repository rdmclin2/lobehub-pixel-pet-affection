#!/usr/bin/env node
'use strict';
// Run the app's ASR core (src/core/asr.js) on an audio file, outside the UI — the same code path as the
// asr-transcribe IPC. For checking a whisper host or the LobeHub path from a shell:
//   node scripts/asr-transcribe.js <audio-file> [--engine lobehub|local] [--fallback] [--language zh]
//        [--endpoint http://127.0.0.1:8179] [--api openai|whispercpp] [--model <m>] [--key <k>] [--test]
// Inside an agent run set PIXELPET_CLEAR_JWT=1 so lh uses the machine's own login (docs/asr-design.md §1.4).
const fs = require('node:fs');
const path = require('node:path');
const { AsrEngine, normalizeAsr, KEY_ID } = require('../src/core/asr');
const { LhClient } = require('../src/core/lh-client');
const { TtsKeyStore } = require('../src/core/tts-keys');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--fallback', '--test'].includes(argv[i - 1])));
const engineId = opt('engine') || 'lobehub';
const set = normalizeAsr({
  enabled: true, engine: engineId, fallback: argv.includes('--fallback'), language: opt('language') || 'auto',
  lobehub: { model: engineId === 'lobehub' && opt('model') ? opt('model') : undefined },
  local: { endpoint: opt('endpoint'), api: opt('api'), model: engineId === 'local' && opt('model') ? opt('model') : undefined },
});
const keys = new TtsKeyStore(null);
if (opt('key')) keys.set(KEY_ID, opt('key'));
const lh = new LhClient();
const engine = new AsrEngine({ lh, keys, log: (r) => console.error('[asr log]', JSON.stringify(r)) });

(async () => {
  console.log('settings.asr =', JSON.stringify(set));
  if (argv.includes('--test')) {
    console.log('test() =>', JSON.stringify(await engine.test(set)));
    return;
  }
  if (!file) throw new Error('usage: asr-transcribe.js <audio-file> [--engine lobehub|local] …');
  const bytes = fs.readFileSync(file);
  const mime = { '.webm': 'audio/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' }[path.extname(file).toLowerCase()] || 'audio/webm';
  console.log(`file = ${file} (${bytes.length} bytes, ${mime})`);
  const r = await engine.transcribe(new Uint8Array(bytes).buffer, mime, set);
  console.log('transcribe() =>', JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(2); });
