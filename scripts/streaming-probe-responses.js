'use strict';
// Streaming probe for the direct path (docs/streaming-audit.md): POST /api/v1/responses with `stream: true`
// — the same request responses-client.js sends with `stream: false` — and record every SSE event with the
// milliseconds since the request started.
//
//   node scripts/streaming-probe-responses.js <out.json> <agentId> "<prompt>" [previous_response_id]
// PROBE_TOOLS=1 offers the app's local function tools (LOCAL_FUNCTION_TOOLS) to see how a parked tool call streams;
// the probe never runs the tool.
//
// Auth is the pet's own (responses-client.readCliCredentials / LOBEHUB_CLI_API_KEY); the token is never written.
const fs = require('node:fs');
const { readCliCredentials, serverUrl, LOCAL_FUNCTION_TOOLS } = require('../src/core/responses-client');

async function main() {
  const [out, agentId, prompt, previous] = process.argv.slice(2);
  if (!out || !agentId || !prompt) {
    console.error('usage: node scripts/streaming-probe-responses.js <out.json> <agentId> "<prompt>" [previous_response_id]');
    process.exit(2);
  }
  const token = process.env.LOBEHUB_CLI_API_KEY || (readCliCredentials() || {}).accessToken;
  if (!token) throw new Error('no LobeHub login (run `lh login` or set LOBEHUB_CLI_API_KEY)');
  const url = `${serverUrl()}/api/v1/responses`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model: agentId, input: prompt, previous_response_id: previous || undefined, stream: true, tools: process.env.PROBE_TOOLS === '1' ? LOCAL_FUNCTION_TOOLS : [], tools_mode: 'exclusive' }),
  });
  const result = { url, status: res.status, contentType: res.headers.get('content-type'), headersMs: Date.now() - t0, reads: [], events: [] };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    const text = decoder.decode(part, { stream: true });
    result.reads.push({ ms: Date.now() - t0, bytes: part.length, text });
    buf += text;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = { ms: Date.now() - t0, event: null, data: null };
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        else if (line.startsWith('data:')) ev.data = (ev.data ? ev.data + '\n' : '') + line.slice(5).trim();
      }
      try { ev.data = JSON.parse(ev.data); } catch { /* keep the raw text ([DONE] etc.) */ }
      result.events.push(ev);
    }
  }
  if (buf.trim()) result.trailing = buf;
  result.totalMs = Date.now() - t0;
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const counts = {};
  for (const e of result.events) counts[e.event || (e.data && e.data.type) || '?'] = (counts[e.event || (e.data && e.data.type) || '?'] || 0) + 1;
  console.log(`status=${res.status} type=${result.contentType} events=${result.events.length} totalMs=${result.totalMs}`);
  console.log(JSON.stringify(counts));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
