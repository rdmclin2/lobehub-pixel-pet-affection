'use strict';
// A stand-in for pixelpet-desktop-helper.exe (src/main/wallpaper/helper/desktop-helper.c) speaking the same JSON-lines
// protocol, so src/main/wallpaper/win-helper.js and the host's recovery are tested on any OS.
// FAKE_HELPER_MODE: ok · no-workerw · hang (never answers) · crash (exits on the first request) ·
//   restart (after the first attach: detaches everything and says shell-restarted, like Explorer restarting) ·
//   occlude (after attach: occluded on, then off)
// FAKE_HELPER_LOG: a file each request is appended to (the tests read what was sent)
const fs = require('node:fs');
const readline = require('node:readline');

const mode = process.env.FAKE_HELPER_MODE || 'ok';
const logFile = process.env.FAKE_HELPER_LOG || null;
const attached = new Map(); // hwnd → parentAlive
let attaches = 0;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(m)}\n`);
  if (mode === 'hang') return;
  if (mode === 'crash') process.exit(3);
  if (m.cmd === 'attach') {
    if (mode === 'no-workerw') { out({ id: m.id, error: 'no-workerw' }); return; }
    attaches += 1;
    attached.set(m.hwnd, true);
    out({ id: m.id, ok: true, layout: '24h2', workerw: '0x10052' });
    if (mode === 'restart' && attaches === 1) setTimeout(() => { for (const k of attached.keys()) attached.set(k, false); out({ event: 'shell-restarted' }); }, 50);
    if (mode === 'occlude' && attaches === 1) { setTimeout(() => out({ event: 'occluded', on: true, why: 'fullscreen' }), 30); setTimeout(() => out({ event: 'occluded', on: false, why: 'none' }), 120); }
    return;
  }
  if (m.cmd === 'status') { out({ id: m.id, ok: true, attached: attached.has(m.hwnd), parentAlive: !!attached.get(m.hwnd), visible: true, layout: '24h2' }); return; }
  if (m.cmd === 'place') { out({ id: m.id, ok: true }); return; }
  if (m.cmd === 'detach') { attached.delete(m.hwnd); out({ id: m.id, ok: true }); return; }
  out({ id: m.id, error: 'bad-request' });
});
rl.on('close', () => process.exit(0));
