'use strict';

// 表情包集合 in the main process (docs/stickers-design.md §2.5, §4): the sticker:// protocol both windows load
// the pictures from, and the settings window's `stickers-*` channels (list / pick + add / remove / update).
// Storage and every check are in src/core/stickers.js (no Electron there).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { protocol, net } = require('electron');
const { StickerLibrary, MAX_STICKER_BYTES } = require('../core/stickers');

const MAX_PICK = 60; // pictures one 添加表情包 takes at a time
const RENDERER = path.join(__dirname, '..', 'renderer');
const BUILTIN_RE = /^\/?([a-z0-9][a-z0-9_.-]{0,80})\/([a-z0-9_-]{1,40})\.webp$/i;

// sticker://blob/<sha256>.<ext>   an imported picture (only names core/stickers.js stores)
// sticker://builtin/<speciesId>/<id>.webp   a built-in meme from src/renderer/assets/memes/
function serveStickers(lib) {
  protocol.handle('sticker', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let file = null;
    if (u.hostname === 'blob') file = lib.blobPath(rel);
    else if (u.hostname === 'builtin') {
      const m = BUILTIN_RE.exec(rel);
      const root = path.join(RENDERER, 'assets', 'memes');
      const f = m && path.resolve(root, m[1], `${m[2]}.webp`);
      file = f && f.startsWith(root + path.sep) && fs.existsSync(f) ? f : null;
    }
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const headers = new Headers(res.headers);
      headers.set('cache-control', 'max-age=31536000, immutable'); // content-addressed: a name never changes picture
      return new Response(res.body, { status: res.status, headers });
    });
  });
}

// Read what the dialog picked: [{ buffer, name }] or { name, error } (too large to even read, gone, a folder).
function readPicked(paths) {
  return paths.slice(0, MAX_PICK).map((p) => {
    const name = path.basename(p);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return { name, error: { reason: 'not-found', message: '不是文件' } };
      if (st.size > MAX_STICKER_BYTES) return { name, error: { reason: 'too-large', message: `超过 ${Math.round(MAX_STICKER_BYTES / 1024 / 1024)} MB` } };
      return { name, buffer: fs.readFileSync(p) };
    } catch {
      return { name, error: { reason: 'not-found', message: '找不到这个文件' } };
    }
  });
}

// The blob names 聊天记录 still mentions (a sticker shown in a chat stays visible after it is deleted).
function blobsInChatLog(userData) {
  try {
    return String(fs.readFileSync(path.join(userData, 'chat-log.json'), 'utf8')).match(/[0-9a-f]{64}\.(?:png|webp|gif|jpg)/g) || [];
  } catch {
    return [];
  }
}

module.exports = { StickerLibrary, serveStickers, readPicked, blobsInChatLog, MAX_PICK };
