'use strict';
// 桌面壁纸: running a small system tool (xprop, gsettings, osascript …) without ever throwing — every platform
// backend takes `run` as a parameter so the tests hand in a fake one. → { ok, code, out, err, missing }
// `missing` = the tool is not installed (ENOENT), which the backends treat differently from "it said no".
const { execFile } = require('node:child_process');

function run(cmd, args = [], { timeout = 5000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, out, errOut) => {
        if (err) resolve({ ok: false, code: typeof err.code === 'number' ? err.code : null, out: String(out || ''), err: String(errOut || err.message || ''), missing: err.code === 'ENOENT' });
        else resolve({ ok: true, code: 0, out: String(out || ''), err: String(errOut || ''), missing: false });
      });
    } catch (e) {
      resolve({ ok: false, code: null, out: '', err: String(e.message || e), missing: e.code === 'ENOENT' });
      return;
    }
    if (input !== null && child.stdin) { child.stdin.end(input); }
  });
}

module.exports = { run };
