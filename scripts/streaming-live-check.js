#!/usr/bin/env node
'use strict';
// Live check of the core streaming layer (docs/streaming-audit.md §4) against the real `lh` and LobeHub:
// runs one turn through LhClient#run and one through ResponsesClient#run (and one with local tools), each with
// onDelta, and prints every delta with its time. Usage:
//   PIXELPET_CLEAR_JWT=1 node scripts/streaming-live-check.js <agentId> ["<prompt>"] > out.json
// Spends a few model calls on <agentId>; use a throwaway agent.
const { LhClient } = require('../src/core/lh-client');
const { ResponsesClient } = require('../src/core/responses-client');

const [agentId, prompt = '写一段大约三百字的秋天散文，分成三段。'] = process.argv.slice(2);
if (!agentId) { console.error('usage: streaming-live-check.js <agentId> ["<prompt>"]'); process.exit(2); }

async function turn(label, fn) {
  const t0 = Date.now();
  const deltas = [];
  const onDelta = (chunk, full) => {
    deltas.push({ ms: Date.now() - t0, chunk, fullLength: full.length });
    process.stderr.write(`[${label} +${Date.now() - t0}ms] ${JSON.stringify(chunk)}\n`);
  };
  try {
    const r = await fn(onDelta);
    const full = deltas.length ? deltas.map((d) => d.chunk).join('') : '';
    return { label, ok: true, totalMs: Date.now() - t0, deltaCount: deltas.length, firstDeltaMs: deltas[0] && deltas[0].ms, lastDeltaMs: deltas.at(-1) && deltas.at(-1).ms, brokenChars: deltas.some((d) => d.chunk.includes('�')), joinedEqualsFinal: full.trim() === r.text || full.endsWith(r.text), result: { text: r.text, topicId: r.topicId ? r.topicId.replace(/^(tpc_)\w+/, '$1…') : null, cost: r.cost }, deltas };
  } catch (e) {
    return { label, ok: false, error: { code: e.code, message: e.message }, deltas };
  }
}

(async () => {
  const lh = new LhClient();
  const responses = new ResponsesClient({ lh });
  const out = [];
  out.push(await turn('lh agent run --json', (onDelta) => lh.run({ agentId, prompt, onDelta })));
  out.push(await turn('responses stream:true', (onDelta) => responses.run({ agentId, prompt, onDelta })));
  out.push(await turn('responses stream:true + local tool', (onDelta) => responses.run({ agentId, prompt: '先说一句“我看看”，然后用 list_directory 工具列出 /tmp/pp-live-dir 目录，再用一句话告诉我里面有什么。', tools: ['lobe-local-system'], onDelta })));
  console.log(JSON.stringify(out, null, 2));
})();
