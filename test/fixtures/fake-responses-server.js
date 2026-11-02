'use strict';
// A local stand-in for LobeHub's Responses API (`POST /api/v1/responses`, docs/streaming-audit.md §4.2), for
// unit tests and the e2e `stream` scenario (no tokens). Point the app at it with LOBEHUB_SERVER=<url> and
// LOBEHUB_CLI_API_KEY=<anything>.
//
// `plan(body, n)` decides each answer (n: 1-based request number); it returns one of
//   { pieces: ['..'], gapMs, id }        an SSE stream: response.created, one output_text.delta per piece
//                                        gapMs apart, output_item.done, response.completed (id: the topic id;
//                                        default previous_response_id or tpc_RESP_<n>)
//   { pieces, gapMs, cutAfter: k }       the stream stops after k pieces without a terminal event
//   { pieces, gapMs, hang: true }        the pieces, then the connection stays open
//   { status: 502, body: '..' }          a plain HTTP error
//   { json: {...} }                      a non-streamed JSON answer
// Every request is recorded in `requests` ({ body, headers, at }).
const http = require('node:http');

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

async function startFakeResponses(plan = () => ({ pieces: ['好的'] })) {
  const srv = { requests: [], plan, sockets: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
      srv.requests.push({ url: req.url, body, headers: req.headers, at: Date.now() });
      const n = srv.requests.length;
      if (req.method !== 'POST' || req.url !== '/api/v1/responses') { res.writeHead(404).end('not found'); return; }
      const p = srv.plan(body, n) || {};
      if (p.status) { res.writeHead(p.status, { 'content-type': 'text/plain' }).end(p.body || 'error'); return; }
      const id = p.id || body.previous_response_id || `tpc_RESP_${n}`;
      const full = (p.pieces || []).join('');
      if (p.json || !body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(p.json || { id, status: 'completed', output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: full }] }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, 'response.created', { response: { id, status: 'in_progress', output: [] } });
      const pieces = p.pieces || [];
      for (let i = 0; i < pieces.length; i++) {
        if (p.cutAfter !== undefined && i >= p.cutAfter) { res.end(); return; }
        if (i && p.gapMs) await new Promise((r) => setTimeout(r, p.gapMs));
        if (res.destroyed) return;
        sse(res, 'response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: pieces[i], sequence_number: i + 2 });
      }
      if (p.cutAfter !== undefined) { res.end(); return; }
      if (p.hang) return;
      sse(res, 'response.output_item.done', { output_index: 0, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: full }] } });
      sse(res, 'response.completed', { response: { id, status: 'completed', output: [], usage: { cost: 0.0001 } } });
      res.end();
    });
  });
  server.on('connection', (s) => { srv.sockets.add(s); s.on('close', () => srv.sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  srv.url = `http://127.0.0.1:${server.address().port}`;
  srv.close = () => new Promise((r) => { for (const s of srv.sockets) s.destroy(); server.close(() => r()); });
  return srv;
}

module.exports = { startFakeResponses };
