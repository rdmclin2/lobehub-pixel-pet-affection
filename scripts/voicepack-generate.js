'use strict';
// Record the built-in voice packs (语音包, core/voice-pack.js): every fixed line of each character in
// her MiniMax voice, into src/voicepacks/<character>/ (manifest.json + one mp3 per line).
// Usage: node scripts/voicepack-generate.js [--only dafeiyu,claude] [--rpm 10] [--limit N]
// The key: $MINIMAX_API_KEY or an `export MINIMAX_API_KEY=…` line (scripts/minimax-key.js); never printed.
// Resumable: lines already on disk are skipped, the manifest is written after every line. MiniMax allows
// 10 requests a minute on the China site (free accounts), so ~220 lines a character take ~25 minutes.
const fs = require('node:fs');
const path = require('node:path');
const tts = require('../src/core/tts');
const VP = require('../src/core/voice-pack');
const { SPECIES, SPECIES_IDS } = require('../src/core/species');
const K = require('./minimax-key');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const only = arg('--only', '') ? arg('--only').split(',') : SPECIES_IDS;
const rpm = Number(arg('--rpm', 10));
const limit = Number(arg('--limit', Infinity));
const ROOT = path.join(__dirname, '..', 'src', 'voicepacks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const { value: key } = K.key();
  if (!key) throw new Error('no MINIMAX_API_KEY (env, ~/.config/pixel-pet/minimax.env or an export line in ~/.zshrc)');
  const endpoint = K.endpoint();
  const gap = Math.ceil(60000 / rpm) + 200;
  let last = 0;
  let made = 0;
  for (const id of only) {
    const sp = SPECIES[id];
    const cfg = tts.PROVIDERS.minimax.config(sp && sp.voice);
    if (!cfg) { log(`${id}: no MiniMax voice in her file, skipped`); continue; }
    const dir = path.join(ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    const mfile = path.join(dir, 'manifest.json');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(mfile, 'utf8')); } catch { /* new */ }
    const credit = (sp.voice.tts.minimax && sp.voice.tts.minimax.credit) || `MiniMax ${cfg.voiceId}`;
    m = { format: VP.FORMAT, id: `${id}-minimax`, name: `${sp.nameZh}（${credit.replace(/^MiniMax 系统音色/, 'MiniMax ')}）`, character: id, engine: 'minimax', voiceId: cfg.voiceId, model: cfg.model, params: { speed: cfg.speed, pitch: cfg.pitch, vol: cfg.vol, emotion: cfg.emotion }, credit: `语音由 AI 合成：${credit}`, lines: m.lines || {} };
    const save = () => { const tmp = `${mfile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n'); fs.renameSync(tmp, mfile); };
    const lines = VP.packLines(sp);
    // lines no longer in her file leave the pack
    for (const t of Object.keys(m.lines)) if (!lines.includes(t)) { try { fs.unlinkSync(path.join(dir, m.lines[t])); } catch { /* gone */ } delete m.lines[t]; }
    const todo = lines.filter((t) => !(m.lines[t] && fs.existsSync(path.join(dir, m.lines[t]))));
    log(`${id}: ${lines.length} lines, ${lines.length - todo.length} already recorded, ${todo.length} to go (voice ${cfg.voiceId})`);
    save();
    for (const text of todo) {
      if (made >= limit) break;
      for (let attempt = 1; ; attempt++) {
        const wait = last + gap - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try {
          const r = await tts.PROVIDERS.minimax.synthesize(cfg, text, { key, endpoint, fetch, signal: AbortSignal.timeout(60000), wait: (p) => p });
          const file = VP.fileFor(text);
          fs.writeFileSync(path.join(dir, file), r.audio);
          m.lines[text] = file;
          save();
          made++;
          if (made % 10 === 0) log(`${id}: ${Object.keys(m.lines).length}/${lines.length} (${made} this run)`);
          break;
        } catch (e) {
          const reason = e.reason || e.name || 'error';
          if (reason === 'http-401' || reason === 'api-1008' || reason === 'http-402') throw new Error(`MiniMax refused: ${reason}`);
          if (attempt >= 4) { log(`${id}: gave up on 「${text}」 (${reason})`); break; }
          const back = /1002|1039|429/.test(reason) ? 20000 : 5000;
          log(`${id}: ${reason}, retry ${attempt} in ${back / 1000}s`);
          await sleep(back);
        }
      }
    }
    log(`${id}: done, ${Object.keys(m.lines).length}/${lines.length} recorded`);
  }
}

main().catch((e) => { console.error(String(e.message || e).split(K.key().value || '\u0000').join('***')); process.exit(1); });
