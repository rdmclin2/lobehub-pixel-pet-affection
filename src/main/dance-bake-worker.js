'use strict';

// Bakes one imported dance off the main thread (docs/vrm-dance.md §2.1, §5.5 step 4): reads the VMD, retargets
// it onto the VRM humanoid (src/core/vmd-retarget.js — the code scripts/vrm-bake.js --dance runs) and checks the
// .vrma it wrote with the app's own reader. Posts { ok, vrma (bytes), report } or { ok: false, message }.
const { parentPort, workerData } = require('node:worker_threads');
const { bake } = require('./dance-bake');

try {
  const r = bake(workerData);
  parentPort.postMessage(r, r.ok ? [r.vrma.buffer] : []);
} catch (e) {
  parentPort.postMessage({ ok: false, message: String((e && e.message) || e) });
}
