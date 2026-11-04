'use strict';
// Review sheets of scanned clips (T-5081, docs/vrm-motion-library.md §3.4): one row per clip, stick figures of its
// coarse joint track (scripts/vrm-motion-scan.js tracks.json) front view, 8 frames across, with its label. Used to
// check by eye what the selection rules picked before a clip goes into the index.
//
//   xvfb-run -a electron --no-sandbox scripts/vrm-motion-sheet.js --list <file.json: [{ src, label }]> --out <png>
//            [--scan ~/vrm-assets/_scan] [--frames 8]

const { app, BrowserWindow } = require('electron');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return out;
}

function page(rows, frames) {
  /* runs in the page */
  const CW = 90;
  const CH = 130;
  const LW = 260;
  const c = document.createElement('canvas');
  c.width = LW + CW * frames;
  c.height = CH * rows.length;
  document.body.style.margin = '0';
  document.body.appendChild(c);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  // joints: hips chest head lElbow lHand rElbow rHand lFoot rFoot
  const bones = [[0, 1, '#555'], [1, 2, '#555'], [1, 3, '#d33'], [3, 4, '#d33'], [1, 5, '#33d'], [5, 6, '#33d'], [0, 7, '#d33'], [0, 8, '#33d']];
  rows.forEach((r, ri) => {
    const y0 = ri * CH;
    g.fillStyle = ri % 2 ? '#f4f4f4' : '#fff';
    g.fillRect(0, y0, c.width, CH);
    g.fillStyle = '#000';
    g.font = '12px sans-serif';
    const words = String(r.label).split('\n');
    words.forEach((w, i) => g.fillText(w.slice(0, 44), 4, y0 + 16 + i * 15));
    const tr = r.track || [];
    for (let k = 0; k < frames; k++) {
      const f = tr[Math.round((k / Math.max(1, frames - 1)) * (tr.length - 1))];
      if (!f) continue;
      const cx = LW + k * CW + CW / 2;
      const base = y0 + CH - 8;
      const s = 50; // px per hip height
      // front view: x → screen right is her left (+X), seen from the front the image is mirrored: draw -x
      const P = (j) => [cx - f[j][0] * s, base - f[j][1] * s];
      g.strokeStyle = '#ddd';
      g.beginPath(); g.moveTo(cx - 40, base); g.lineTo(cx + 40, base); g.stroke();
      g.lineWidth = 2;
      for (const [a, b, col] of bones) { const pa = P(a); const pb = P(b); g.strokeStyle = col; g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]); g.stroke(); }
      const h = P(2);
      g.fillStyle = '#000';
      g.beginPath(); g.arc(h[0], h[1], 5, 0, Math.PI * 2); g.fill();
      // her facing (z of the head - chest): a short tick
      g.lineWidth = 1;
    }
  });
  return [c.width, c.height];
}

app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.whenReady().then(async () => {
  const a = args(process.argv.slice(2));
  const scan = path.resolve(home(a.scan || '~/vrm-assets/_scan'));
  const tracks = JSON.parse(fs.readFileSync(path.join(scan, 'tracks.json'), 'utf8')).clips;
  const list = JSON.parse(fs.readFileSync(path.resolve(a.list), 'utf8'));
  const frames = Number(a.frames) || 8;
  const rows = list.map((r) => ({ label: r.label || r.src, track: tracks[r.src] }));
  const win = new BrowserWindow({ show: false, width: 260 + 90 * frames, height: Math.max(100, 130 * rows.length), webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const [w, h] = await win.webContents.executeJavaScript(`(${page.toString()})(${JSON.stringify(rows)}, ${frames})`);
  win.setContentSize(w, h);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  fs.writeFileSync(path.resolve(a.out), img.toPNG());
  console.log(`wrote ${a.out} (${rows.length} clips)`);
  app.quit();
});
