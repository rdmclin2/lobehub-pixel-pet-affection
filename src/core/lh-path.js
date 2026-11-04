'use strict';

// Apps launched from Finder/Dock do not inherit the shell's PATH, so on macOS a
// packaged app cannot see an `lh` installed through Homebrew, nvm, fnm or volta,
// and `lh` itself (a `#!/usr/bin/env node` script) cannot see `node`. Locate
// both explicitly.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const realFs = {
  exists: (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile() || fs.statSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  isDir: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
};

// Newest-first version directories, e.g. ~/.nvm/versions/node/v24.1.0
function versionDirs(root, suffix, io) {
  return io
    .readdir(root)
    .filter((n) => /^v?\d/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((n) => path.join(root, n, suffix));
}

function candidateDirs({ home = os.homedir(), io = realFs } = {}) {
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, 'Library/pnpm'), // pnpm's global bin on macOS (PNPM_HOME)
    path.join(home, '.local/share/pnpm'), // ... and on Linux
    path.join(home, '.asdf/shims'),
    ...versionDirs(path.join(home, '.nvm/versions/node'), 'bin', io),
    ...versionDirs(path.join(home, '.fnm/node-versions'), 'installation/bin', io),
    ...versionDirs(path.join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin', io),
    ...versionDirs(path.join(home, '.local/share/fnm/node-versions'), 'installation/bin', io),
    '/usr/bin',
  ];
  return dirs.filter((d) => io.isDir(d));
}

// The login-shell lookup below runs the owner's interactive shell setup (~/.zshrc: oh-my-zsh, prompts,
// plugins...) as a child of the app, so on macOS whatever that setup touches in Downloads / Desktop /
// Documents is asked for in the app's name (T-3386). Its answer is remembered in a small file, and later
// launches use it while that `lh` still exists instead of running the shell again.
// fileCache(file) -> { get(): path | null, set(path) }; errors are ignored (the lookup simply runs again).
function fileCache(file) {
  return {
    get: () => {
      try {
        const p = JSON.parse(fs.readFileSync(file, 'utf8')).lh;
        return typeof p === 'string' && path.isAbsolute(p) ? p : null;
      } catch {
        return null;
      }
    },
    set: (p) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ lh: p }));
      } catch { /* not remembered: the next launch asks the shell again */ }
    },
  };
}

function loginShellLookup(env = process.env) {
  const shell = env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'command -v lh'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const last = out.trim().split('\n').pop();
    return last && path.isAbsolute(last) ? last : null;
  } catch {
    return null;
  }
}

// ---- Windows --------------------------------------------------------------------------------
// There `lh` is an npm shim (`lh.cmd`). Node refuses to spawn .cmd files without a shell, and a shell
// would put the pet's (user-influenced) prompt text through cmd.exe quoting, which is a command
// injection risk. So we read the shim to find the JS entry it launches and run that directly with the
// app's own Electron binary acting as node (ELECTRON_RUN_AS_NODE), no shell involved.
const winPath = path.win32;

function windowsCandidateDirs({ env, io }) {
  const dirs = [];
  if (env.APPDATA) dirs.push(winPath.join(env.APPDATA, 'npm'));
  if (env.LOCALAPPDATA) dirs.push(winPath.join(env.LOCALAPPDATA, 'Volta', 'bin'), winPath.join(env.LOCALAPPDATA, 'pnpm'));
  if (env.USERPROFILE) dirs.push(winPath.join(env.USERPROFILE, '.bun', 'bin'));
  if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
  dirs.push(winPath.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
  return dirs.filter((d) => io.isDir(d));
}

// npm's cmd shim ends with:  "%_prog%"  "%dp0%\node_modules\@lobehub\cli\dist\index.js" %*
function resolveWindowsEntry(cmdPath, { read = (p) => fs.readFileSync(p, 'utf8'), io = realFs } = {}) {
  let text;
  try {
    text = read(cmdPath);
  } catch {
    return null;
  }
  const m = text.match(/"%dp0%\\([^"\r\n]+?\.(?:c|m)?js)"/i);
  if (!m) return null;
  const entry = winPath.join(winPath.dirname(cmdPath), m[1]);
  return io.exists(entry) ? entry : null;
}

// How to start the `lh` we found: { command, prefix (args placed before ours), env (extra variables) }.
function spawnTarget(bin, { platform = process.platform, execPath = process.execPath, read, io = realFs } = {}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const entry = resolveWindowsEntry(bin, { read, io });
    if (!entry) throw new Error(`Cannot run ${bin} without a shell and could not find the script it launches. Reinstall the CLI: npm install -g @lobehub/cli`);
    return { command: execPath, prefix: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { command: bin, prefix: [], env: {} };
}

// Returns an absolute path to `lh`, or null. `lookup` is the login-shell fallback (injectable for tests);
// `cache` ({ get, set }, see fileCache) remembers what it found so it does not run at every launch.
function findLh({ env = process.env, home = os.homedir(), io = realFs, lookup = loginShellLookup, platform = process.platform, cache = null } = {}) {
  if (env.LH_BIN) return env.LH_BIN;
  if (platform === 'win32') {
    const dirs = [...(env.PATH || env.Path || '').split(';').filter(Boolean), ...windowsCandidateDirs({ env, io })];
    for (const d of dirs) {
      for (const name of ['lh.cmd', 'lh.exe']) {
        const p = winPath.join(d, name);
        if (io.exists(p)) return p;
      }
    }
    return null;
  }
  const dirs = [...(env.PATH || '').split(path.delimiter).filter(Boolean), ...candidateDirs({ home, io })];
  for (const d of dirs) {
    const p = path.join(d, 'lh');
    if (io.exists(p)) return p;
  }
  const remembered = cache && cache.get();
  if (remembered && io.exists(remembered)) return remembered;
  const found = lookup(env);
  if (found && cache) cache.set(found);
  return found;
}

// PATH that lets `lh` find `node`: its own directory first (nvm/fnm/volta keep both together).
function withToolPath(env, lhPath, { home = os.homedir(), io = realFs, platform = process.platform } = {}) {
  if (platform === 'win32') return env; // Windows GUI apps inherit the user PATH; lh is started through its JS entry anyway
  const dirs = [];
  if (lhPath && path.isAbsolute(lhPath)) {
    const real = (() => { try { return fs.realpathSync(lhPath); } catch { return lhPath; } })();
    dirs.push(path.dirname(lhPath), path.dirname(real));
  }
  dirs.push(...candidateDirs({ home, io }), ...(env.PATH || '').split(path.delimiter).filter(Boolean));
  return { ...env, PATH: [...new Set(dirs)].join(path.delimiter) };
}

module.exports = { findLh, fileCache, withToolPath, candidateDirs, spawnTarget, resolveWindowsEntry, windowsCandidateDirs, realFs };
