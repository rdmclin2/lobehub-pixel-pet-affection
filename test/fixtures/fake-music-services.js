'use strict';
// Local stand-ins for the two music services added in T-5651 (core/music-fal.js, core/music-elevenlabs.js), for unit
// tests, the e2e `music` scenario and `npm run music:smoke -- --mock`: no key, no quota, no network beyond 127.0.0.1.
// The app is pointed at them with FAL_MUSIC_ENDPOINT / ELEVENLABS_MUSIC_ENDPOINT=<url> (accepted on http://127.0.0.1
// only in test mode, music.resolveConfig allowInsecureLocal) and FAL_KEY / ELEVENLABS_API_KEY=<anything>.
//
// fal queue (https://fal.ai/docs/model-apis/model-endpoints/queue):
//   POST /<owner>/<app>/<version>          → { request_id, status_url, response_url, cancel_url, queue_position }
//   GET  /<owner>/<app>/requests/<id>/status → falPlan(input, n).statuses[k] (k = poll count, last one repeats)
//   GET  /<owner>/<app>/requests/<id>      → { audio: { url, content_type, file_name, file_size } } or the plan's result error
//   PUT  /<owner>/<app>/requests/<id>/cancel → 202 { status: 'CANCELLATION_REQUESTED' } (recorded in `cancels`)
//   falPlan(input, n) returns { submit?: { status, body }, statuses?: [...status bodies], result?: { status, body } }
//   default: IN_QUEUE → IN_PROGRESS → COMPLETED, then the sample mp3.
// ElevenLabs (POST /v1/music?output_format=…, xi-api-key): elPlan(body, n) → { delayMs?, status?, body? } — default
//   200 with the sample mp3 and a song-id header.
// GET /files/<name>.mp3 serves test/fixtures/music-sample.mp3 (3 s, C–E–G). Everything is recorded in `requests`.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SAMPLE = path.join(__dirname, 'music-sample.mp3');
const FAL_OK = [{ status: 'IN_QUEUE', queue_position: 1 }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED', metrics: { inference_time: 1.2 } }];

async function startFakeMusicServices({ falPlan = () => ({}), elPlan = () => ({}) } = {}) {
  const audio = fs.readFileSync(SAMPLE);
  const srv = { requests: [], fal: { submits: [], polls: 0, cancels: [] }, el: { requests: [] }, downloads: 0, falPlan, elPlan, sockets: new Set() };
  const tasks = new Map(); // request_id → { plan, polls }
  const send = (res, status, body, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      srv.requests.push({ method: req.method, path: u.pathname, query: u.search, headers: req.headers, body, at: Date.now() });
      if (req.method === 'GET' && u.pathname.startsWith('/files/')) {
        srv.downloads++;
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length }).end(audio);
        return;
      }
      // ---- ElevenLabs
      if (u.pathname === '/v1/music' && req.method === 'POST') {
        srv.el.requests.push({ body, query: Object.fromEntries(u.searchParams), headers: req.headers });
        const p = srv.elPlan(body, srv.el.requests.length) || {};
        if (p.delayMs) await new Promise((r) => setTimeout(r, p.delayMs));
        if (res.destroyed) return;
        if (p.status) { send(res, p.status, p.body || {}); return; }
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length, 'song-id': `song-${srv.el.requests.length}` }).end(audio);
        return;
      }
      // ---- fal queue
      const m = /^\/([^/]+\/[^/]+)\/requests\/([^/]+)(\/status|\/cancel)?$/.exec(u.pathname);
      if (m) {
        const t = tasks.get(m[2]);
        if (!t) { send(res, 404, { status: 'NOT_FOUND' }); return; }
        if (m[3] === '/cancel' && req.method === 'PUT') { srv.fal.cancels.push(m[2]); t.cancelled = true; send(res, 202, { status: 'CANCELLATION_REQUESTED' }); return; }
        if (m[3] === '/status' && req.method === 'GET') {
          srv.fal.polls++;
          const list = t.plan.statuses || FAL_OK;
          const s = list[Math.min(t.polls, list.length - 1)];
          t.polls++;
          if (s && s.httpStatus) { send(res, s.httpStatus, s.body || {}); return; }
          send(res, 202, { ...s, request_id: m[2] });
          return;
        }
        if (!m[3] && req.method === 'GET') {
          if (t.plan.result) { send(res, t.plan.result.status || 200, t.plan.result.body || {}); return; }
          send(res, 200, { audio: { url: `${srv.url}/files/${m[2]}.mp3`, content_type: 'audio/mpeg', file_name: `${m[2]}.mp3`, file_size: audio.length } });
          return;
        }
      }
      if (req.method === 'POST' && /^\/[^/]+\/[^/]+(\/[^/]+)?$/.test(u.pathname) && req.headers.authorization) {
        srv.fal.submits.push({ model: u.pathname.slice(1), input: body, headers: req.headers });
        const plan = srv.falPlan(body, srv.fal.submits.length) || {};
        if (plan.submit) { send(res, plan.submit.status, plan.submit.body || {}); return; }
        const id = `req-${srv.fal.submits.length}`;
        const app = u.pathname.slice(1).split('/').slice(0, 2).join('/');
        tasks.set(id, { plan, polls: 0 });
        const base = `${srv.url}/${app}/requests/${id}`;
        send(res, 200, { request_id: id, status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel`, queue_position: 0 });
        return;
      }
      res.writeHead(404).end('not found');
    });
  });
  server.on('connection', (s) => { srv.sockets.add(s); s.on('close', () => srv.sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  srv.url = `http://127.0.0.1:${server.address().port}`;
  srv.close = () => new Promise((r) => { for (const s of srv.sockets) s.destroy(); server.close(() => r()); });
  return srv;
}

module.exports = { startFakeMusicServices, SAMPLE, FAL_OK };
