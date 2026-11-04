'use strict';

// 对话测速埋点 (docs/admin-chat-latency.md). Off by default: nothing is measured or written unless the app runs
// with PIXELPET_LATENCY=1. Then every chat turn — the desktop chat box (PetService#chat) and the settings
// window's 聊天 (PetService#chatAs) — writes one JSON line when it ends: when each step finished (ms since the
// turn started in main), how large the prompt was, which way the turn went (direct Responses SSE, or the
// `lh agent run` fallback and why), and how many reply pieces went to the window (count and bytes, since the
// chat page gets the whole text so far every time). Lines go to PIXELPET_LATENCY_FILE (default
// <data dir>/latency.jsonl) and to stdout as `[latency] {…}`. Electron-free; the tests use the no-op trace.

const fs = require('node:fs');

const NOOP = Object.freeze({ on: false, mark() {}, markLast() {}, set() {}, add() {}, end() {} });

const enabled = (env = process.env) => env.PIXELPET_LATENCY === '1';

// One turn. mark(name): the first time a step is reached (ms since start, later calls keep the first one);
// markLast(name): every time (the last one stays); set(k, v): a fact about the turn; add(k, n): a counter; end(): written once.
function createTrace(kind, { env = process.env, file = env.PIXELPET_LATENCY_FILE || null, now = () => Date.now(), write = null } = {}) {
  if (!enabled(env)) return NOOP;
  const t0 = now();
  const marks = {};
  const fields = {};
  let done = false;
  return {
    on: true,
    t0,
    mark(name) {
      if (!(name in marks)) marks[name] = now() - t0;
    },
    markLast(name) {
      marks[name] = now() - t0;
    },
    set(k, v) {
      fields[k] = v;
    },
    add(k, n = 1) {
      fields[k] = (fields[k] || 0) + n;
    },
    end(extra = {}) {
      if (done) return;
      done = true;
      marks.end = now() - t0;
      const line = JSON.stringify({ kind, t0, ...fields, ...extra, marks });
      try {
        if (write) write(line);
        else {
          if (file) fs.appendFileSync(file, `${line}\n`);
          process.stdout.write(`[latency] ${line}\n`);
        }
      } catch { /* a measurement must never cost the turn */ }
    },
  };
}

module.exports = { createTrace, enabled, NOOP };
