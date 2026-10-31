'use strict';

// Pet packs on disk: the built-in ones (src/renderer/packs) and the user's own (<userData>/packs),
// served to the renderer over `pack://<id>/<file>`. Importing copies a pack folder (or a .zip of one)
// into the user folder after checking it with src/core/packs.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, protocol, net } = require('electron');
const P = require('../core/packs');

// Must run before the app is ready. CORS-enabled so the page can read a sheet's pixels (部位触摸 hit-tests
// clicks against her opaque pixels); the files are pictures only, see serve().
function registerPackScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'pack', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, _o, stderr) => (e ? reject(new Error(String(stderr || e.message).trim().slice(0, 200))) : resolve())));

function unzip(zip, dest) {
  if (process.platform === 'darwin') return run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
  if (process.platform === 'win32') return run('tar', ['-xf', zip, '-C', dest]); // bsdtar ships with Windows 10+
  return run('unzip', ['-q', zip, '-d', dest]);
}

class PackStore {
  constructor() {
    this.builtinDir = path.join(__dirname, '..', 'renderer', 'packs');
    this.userDir = path.join(app.getPath('userData'), 'packs');
    fs.mkdirSync(this.userDir, { recursive: true });
    this.reload();
  }

  reload() {
    const { packs, problems } = P.loadPacks([{ dir: this.builtinDir, source: 'builtin' }, { dir: this.userDir, source: 'user' }]);
    this.packs = packs;
    this.problems = problems;
    return packs;
  }

  // pack://<id>/<file>: only files inside that pack's folder.
  serve() {
    protocol.handle('pack', (req) => {
      const u = new URL(req.url);
      const pack = this.packs.get(u.hostname);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const file = pack && path.resolve(pack.dir, rel);
      if (!pack || !file.startsWith(pack.dir + path.sep) || !/\.(png|webp|gif|jpe?g|json|moc3)$/i.test(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString()).then((res) => {
        const headers = new Headers(res.headers);
        headers.set('access-control-allow-origin', '*');
        return new Response(res.body, { status: res.status, headers });
      });
    });
  }

  // Import a pack folder or a .zip holding one (pack.json at its top or one folder down). A pack with the
  // id of a built-in one is refused; one with the id of an imported one replaces it.
  async importFrom(src) {
    let dir = src;
    let tmp = null;
    try {
      if (/\.zip$/i.test(src)) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-pack-'));
        await unzip(src, tmp);
        dir = fs.existsSync(path.join(tmp, 'pack.json')) ? tmp : fs.readdirSync(tmp, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(tmp, d.name, 'pack.json'))).map((d) => path.join(tmp, d.name))[0];
        if (!dir) return { ok: false, errors: ['the .zip has no pack.json'] };
      }
      const r = P.readPack(dir);
      if (!r.ok) return r;
      const existing = this.packs.get(r.pack.id);
      if (existing && existing.source === 'builtin') return { ok: false, errors: [`id ${r.pack.id} belongs to a built-in pack; give the pack its own id`] };
      const dest = path.join(this.userDir, r.pack.id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(dir, dest, { recursive: true, dereference: true });
      this.reload();
      return { ok: true, pack: { id: r.pack.id, name: r.pack.name, species: r.pack.species }, replaced: !!existing };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  remove(id) {
    const p = this.packs.get(id);
    if (!p || p.source !== 'user') return { ok: false, reason: 'not-user-pack' };
    fs.rmSync(p.dir, { recursive: true, force: true });
    this.reload();
    return { ok: true };
  }
}

module.exports = { registerPackScheme, PackStore };
