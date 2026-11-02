'use strict';
// Facts the streaming audit (docs/streaming-audit.md §4) rests on, checked against the recorded samples in
// test/fixtures/streaming (real `lh` 0.0.62 / app.lobehub.com runs, redacted by scripts/streaming-redact.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseRunEvents, runEndCode } = require('../src/core/lh-client');

const fx = (n) => require(path.join(__dirname, 'fixtures', 'streaming', n));
const stdoutOf = (r) => r.chunks.filter((c) => c.stream === 'stdout');
const eventsOf = (r) => {
  const s = stdoutOf(r).map((c) => c.text).join('');
  return JSON.parse(s.slice(s.indexOf('[')));
};

for (const name of ['lh-run-json.json', 'lh-run-json-long.json', 'lh-run-sse-json.json']) {
  test(`${name}: --json writes the whole event array in one burst at the end, although it holds stream_chunk events`, () => {
    const r = fx(name);
    // the redactor joins the array's writes into one chunk and keeps each write's time in mergedWrites
    const out = stdoutOf(r);
    assert.equal(out.length, 1);
    const writes = out[0].mergedWrites;
    assert.ok(writes.length <= 2, `stdout writes: ${writes.length}`);
    assert.ok(writes[writes.length - 1].ms - writes[0].ms < 50, 'all stdout arrives at the same moment');
    const events = eventsOf(r);
    const text = events.filter((e) => e.type === 'stream_chunk' && e.data.chunkType === 'text');
    assert.ok(text.length >= 2, 'the server did stream the reply in pieces');
    // the pieces were produced over time server-side, yet reach the app together
    assert.ok(text[text.length - 1].timestamp > text[0].timestamp);
    // what the app uses today: stream_end.finalContent equals the concatenated text chunks
    const parsed = parseRunEvents(stdoutOf(r).map((c) => c.text).join(''));
    assert.equal(parsed.text, text.map((e) => e.data.content).join('').trim());
    // the app settles on the terminal event; note: a successful run ends with reason "done", which
    // runEndCode reports as 1 (harmless today because parseRunEvents found the text first)
    const end = events.find((e) => e.type === 'agent_runtime_end');
    assert.equal(end.data.reason, 'done');
    assert.notEqual(runEndCode(stdoutOf(r).map((c) => c.text).join('')), undefined);
  });
}

test('lh-run-text-long.json: without --json the reply text reaches stdout piece by piece', () => {
  const out = stdoutOf(fx('lh-run-text-long.json'));
  assert.ok(out.length >= 10, `stdout writes: ${out.length}`);
  assert.ok(out[out.length - 1].ms - out[0].ms > 3000, 'spread over seconds');
});

test('lh-run-sse-text.json: in text mode, reasoning is written unmarked next to the reply when stdout is not a TTY', () => {
  const all = stdoutOf(fx('lh-run-sse-text.json')).map((c) => c.text).join('');
  assert.ok(!all.includes('\u001b['), 'no ANSI codes, so nothing separates reasoning from text');
  const ev = eventsOf(fx('lh-run-sse-json.json')); // a sibling run of the same prompt shows the reasoning chunk exists
  assert.ok(ev.some((e) => e.type === 'stream_chunk' && e.data.chunkType === 'reasoning'));
});

for (const name of ['responses-sse.json', 'responses-sse-long.json']) {
  test(`${name}: /api/v1/responses stream:true is SSE whose output_text.delta pieces add up to output_text.done`, () => {
    const r = fx(name);
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/event-stream/);
    const deltas = r.events.filter((e) => e.event === 'response.output_text.delta');
    const done = r.events.find((e) => e.event === 'response.output_text.done');
    assert.ok(deltas.length >= 1 && done);
    assert.equal(deltas.map((e) => e.data.delta).join(''), done.data.text);
    const end = r.events[r.events.length - 1];
    assert.equal(end.event, 'response.completed');
    assert.equal(end.data.response.id, r.events[0].data.response.id, 'the response id (= topic id) is known from the first event');
  });
}

test('responses-sse-long.json: a long reply arrives as several deltas over time', () => {
  const deltas = fx('responses-sse-long.json').events.filter((e) => e.event === 'response.output_text.delta');
  assert.ok(deltas.length >= 5, `deltas: ${deltas.length}`);
  assert.ok(deltas[deltas.length - 1].ms - deltas[0].ms > 1000);
});

test('responses-sse-tool.json: a parked local tool call streams its preamble text, then ends as response.incomplete', () => {
  const ev = fx('responses-sse-tool.json').events;
  assert.ok(ev.some((e) => e.event === 'response.output_text.delta'));
  assert.ok(ev.some((e) => e.event === 'response.function_call_arguments.done'));
  const end = ev[ev.length - 1];
  assert.equal(end.event, 'response.incomplete');
  assert.equal(end.data.response.incomplete_details.reason, 'client_tool_execution');
});
