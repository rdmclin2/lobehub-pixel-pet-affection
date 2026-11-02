'use strict';
// Streaming probe (docs/streaming-audit.md): does `lh agent run` give us the reply incrementally?
// Spawns the real `lh` the same way the app does (lh-client.cleanEnv: no run-context vars), records every
// stdout chunk with the milliseconds since spawn, and writes the result as JSON.
//
//   node scripts/streaming-probe.js <out.json> -- agent run -a <agentId> -p "<prompt>" [--json|--sse|-v]
//
// The output keeps the chunk text; scripts/streaming-redact.js removes ids and tokens before it is committed.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { cleanEnv } = require('../src/core/lh-client');
const { findLh } = require('../src/core/lh-path');

const [out, sep, ...args] = process.argv.slice(2);
if (!out || sep !== '--' || !args.length) {
  console.error('usage: node scripts/streaming-probe.js <out.json> -- <lh args…>');
  process.exit(2);
}
const bin = findLh() || 'lh';
const t0 = Date.now();
const chunks = [];
const child = spawn(bin, args, { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
const rec = (stream) => (d) => chunks.push({ ms: Date.now() - t0, stream, text: String(d) });
child.stdout.on('data', rec('stdout'));
child.stderr.on('data', rec('stderr'));
child.on('close', (code) => {
  const stdout = chunks.filter((c) => c.stream === 'stdout');
  const result = {
    command: ['lh', ...args],
    exitCode: code,
    totalMs: Date.now() - t0,
    stdoutChunks: stdout.length,
    firstStdoutMs: stdout.length ? stdout[0].ms : null,
    lastStdoutMs: stdout.length ? stdout[stdout.length - 1].ms : null,
    chunks,
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`exit=${code} totalMs=${result.totalMs} stdoutChunks=${result.stdoutChunks} first=${result.firstStdoutMs} last=${result.lastStdoutMs}`);
});
