'use strict';

// One VMD → { ok, vrma: Uint8Array, report } (the worker's job; also run in-process when a worker cannot start).
const fs = require('node:fs');
const R = require('../core/vmd-retarget');
const V = require('../core/vrm');

function bake({ vmd, id }) {
  const buf = fs.readFileSync(vmd);
  const { vrma, report } = R.bakeVmd(buf, { name: id, face: true });
  const jl = vrma.readUInt32LE(12);
  const check = V.inspectVrmaJson(JSON.parse(vrma.subarray(20, 20 + jl).toString('utf8')));
  if (!check.ok) return { ok: false, message: `inspectVrmaJson: ${check.errors.join('; ')}` };
  const out = new Uint8Array(vrma.length);
  out.set(vrma);
  const { duration, face, ik, stage, extent, ground } = report;
  return { ok: true, vrma: out, report: { duration, face: !!face, ik, stage: stage ? { radius: stage.radius, clampHits: stage.clampHits } : null, extent, ground } };
}

module.exports = { bake };
