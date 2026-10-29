'use strict';

// The HTTP side of the local API (routing and checks in src/core/api.js): 127.0.0.1 only, JSON bodies
// up to 16 KB. Started and stopped as 高级设置 → 对外接口 is switched.
const http = require('node:http');
const api = require('../core/api');

class ApiServer {
  constructor(ctx, log = () => {}) {
    this.ctx = ctx;
    this.log = log;
    this.server = null;
    this.port = null;
    this.error = null;
  }

  // Listen on `port` (or stop with enabled = false). Resolves once listening or failed.
  async apply({ enabled, port }) {
    if (this.server && (!enabled || port !== this.port)) await this.stop();
    if (!enabled || this.server) return this.status();
    this.error = null;
    const server = http.createServer((req, res) => this._serve(req, res));
    await new Promise((resolve) => {
      server.once('error', (e) => { this.error = e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : e.message; this.log(e); resolve(); });
      server.listen(port, '127.0.0.1', () => { this.server = server; this.port = port; resolve(); });
    });
    return this.status();
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.port = null;
    if (s) await new Promise((resolve) => s.close(() => resolve()));
  }

  status() {
    return { listening: !!this.server, port: this.port, error: this.error };
  }

  _serve(req, res) {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > api.MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body = {};
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      }
      let out;
      if (body === null) out = { status: 400, json: { ok: false, error: 'bad-json' } };
      else {
        try { out = await api.handle({ method: req.method, path: req.url, headers: req.headers, body }, { ...this.ctx, token: this.ctx.token() }); } catch (e) { this.log(e); out = { status: 500, json: { ok: false, error: 'internal' } }; }
      }
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out.json));
    });
  }
}

module.exports = { ApiServer };
