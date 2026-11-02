'use strict';
// Redact a probe result (scripts/streaming-probe*.js) before it is committed as a fixture:
//   - LobeHub ids (agt_ / tpc_ / op_ / msg_ / user_ / call_ / file_ …) → stable placeholders (same id → same placeholder)
//   - fields that carry the account's private context (the agent's full system role, tool manifests, memory,
//     sender profile) → "[redacted: N bytes]"; the event shapes and every streamed text chunk stay as they were.
//
//   node scripts/streaming-redact.js <in.json> <out.json>
const fs = require('node:fs');

const PRIVATE_KEYS = new Set(['finalState', 'agentConfig', 'uiMessages', 'llmCalls', 'sender', 'instructions', 'tools', 'avatar', 'email']);
// no \b: ids also sit right after ANSI colour codes ("\x1b[2mop_…") and inside compound ids ("msg_tpc_…_0").
// Lengths keep ordinary words (top_p, top_logprobs) out.
const ID_RE = /(op)_\d{10,}_[A-Za-z0-9_]+|(agt|tpc|msg|file|ses|thd|wsp)_[A-Za-z0-9]{10,}|(user)_[A-Za-z0-9]{20,}|(call)_[A-Za-z0-9_]{10,}/g;

function redactIds(s, map) {
  return s.replace(ID_RE, (id, a, b, c, d) => {
    const kind = a || b || c || d;
    if (!map.has(id)) map.set(id, `${kind}_REDACTED${[...map.keys()].filter((k) => k.startsWith(`${kind}_`)).length + 1}`);
    return map.get(id);
  });
}

function walk(v, map) {
  if (typeof v === 'string') {
    // an lh --json stdout chunk is itself JSON: redact inside it, keep it a string
    const t = v.trim();
    if ((t.startsWith('[') || t.startsWith('{')) && t.length > 2) {
      try { return JSON.stringify(walk(JSON.parse(t), map), null, 2) + (v.endsWith('\n') ? '\n' : ''); } catch { /* plain text */ }
    }
    // a raw SSE read: whole data lines are walked as JSON; a line split across two reads is only id-redacted
    if (v.includes('data: ')) return redactIds(v.replace(/^data: (.*)$/gm, (l, d) => { try { return `data: ${JSON.stringify(walk(JSON.parse(d), map))}`; } catch { return l; } }), map);
    return redactIds(v, map);
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, map));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (PRIVATE_KEYS.has(k) && x != null && !(Array.isArray(x) && x.length === 0)) o[k] = `[redacted: ${Buffer.byteLength(JSON.stringify(x))} bytes]`;
      else o[k] = walk(x, map);
    }
    return o;
  }
  return v;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/streaming-redact.js <in.json> <out.json>');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
// `lh --json` may print its one JSON array in several stdout writes; a piece alone is not JSON, so join them
// (keeping each write's time and size) and redact the whole array.
if (Array.isArray(raw.chunks)) {
  const out = raw.chunks.filter((c) => c.stream === 'stdout');
  const joined = out.map((c) => c.text).join('');
  const at = joined.indexOf('[');
  let parsed = null;
  if (at >= 0 && out.length > 1) try { parsed = JSON.parse(joined.slice(at)); } catch { /* text mode: leave the writes as they are */ }
  if (parsed) {
    const first = raw.chunks.indexOf(out[0]);
    const merged = { ms: out[out.length - 1].ms, stream: 'stdout', text: joined, mergedWrites: out.map((c) => ({ ms: c.ms, bytes: Buffer.byteLength(c.text) })) };
    raw.chunks = [...raw.chunks.slice(0, first).filter((c) => c.stream !== 'stdout'), merged, ...raw.chunks.slice(first).filter((c) => c.stream !== 'stdout')];
  }
}
const data = walk(raw, new Map());
data.redacted = 'ids replaced by placeholders; private context fields replaced by their size (scripts/streaming-redact.js)';
fs.writeFileSync(output, JSON.stringify(data, null, 2) + '\n');
