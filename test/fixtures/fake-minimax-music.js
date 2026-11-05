'use strict';
// A local stand-in for MiniMax's music generation endpoint (`POST /v1/music_generation`, core/music.js), for the
// e2e `musicchat` scenario and unit tests: no key, no quota. The app is pointed at it with
// MINIMAX_MUSIC_ENDPOINT=<url> (accepted on http://127.0.0.1 only in test mode, music.resolveConfig
// allowInsecureLocal) and MINIMAX_API_KEY=<anything>.
//
// `plan(body, n)` decides each answer (n: 1-based); it returns one of
//   { delayMs }                      wait, then { data: { status: 2, audio: <url of the sample mp3> }, extra_info, base_resp 0 }
//   { delayMs, hex: true }           the same, the audio as hex in the answer
//   { code: 1008, msg: '...' }       a MiniMax error (base_resp.status_code ≠ 0, HTTP 200)
//   { status: 500 }                  a plain HTTP error
// GET /audio/<name>.mp3 serves the sample (test/fixtures/music-sample.mp3: 3 s, C–E–G). Every POST is recorded in
// `requests` ({ body, headers, at }); `downloads` counts GET /audio.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SAMPLE = path.join(__dirname, 'music-sample.mp3');

async function startFakeMiniMaxMusic(plan = () => ({})) {
  const audio = fs.readFileSync(SAMPLE);
  const srv = { requests: [], downloads: 0, plan, sockets: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url.startsWith('/audio/')) {
        srv.downloads++;
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length }).end(audio);
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/music_generation') { res.writeHead(404).end('not found'); return; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
      srv.requests.push({ body, headers: req.headers, at: Date.now() });
      const p = srv.plan(body, srv.requests.length) || {};
      if (p.delayMs) await new Promise((r) => setTimeout(r, p.delayMs));
      if (res.destroyed) return;
      if (p.status) { res.writeHead(p.status, { 'content-type': 'text/plain' }).end('error'); return; }
      if (p.code) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ base_resp: { status_code: p.code, status_msg: p.msg || 'error' }, trace_id: `trace-${srv.requests.length}` })); return; }
      const a = p.hex ? audio.toString('hex') : `${srv.url}/audio/song-${srv.requests.length}.mp3`;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { status: 2, audio: a }, trace_id: `trace-${srv.requests.length}`, extra_info: { music_duration: 3030, music_sample_rate: 44100, music_channel: 1, bitrate: 64000, music_size: audio.length }, base_resp: { status_code: 0, status_msg: 'success' } }));
    });
  });
  server.on('connection', (s) => { srv.sockets.add(s); s.on('close', () => srv.sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  srv.url = `http://127.0.0.1:${server.address().port}`;
  srv.close = () => new Promise((r) => { for (const s of srv.sockets) s.destroy(); server.close(() => r()); });
  return srv;
}

module.exports = { startFakeMiniMaxMusic, SAMPLE };
