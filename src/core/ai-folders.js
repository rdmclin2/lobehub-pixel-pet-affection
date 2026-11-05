'use strict';

// AI 可读的文件夹 (T-5075, docs/permissions.md): the folders the owner lets her local tools touch.
//
// settings.local = { folders, allowCommands, asked }
//  - folders: null = no limit (only for owners who had 本机能力 on before this list existed; PetService.init
//    decides once), [] = nothing allowed yet, [abs, …] = read_file / list_directory / write_file stay inside.
//  - allowCommands: run_command is offered at all (its cwd must be inside a folder; the command itself is not
//    sandboxed and can reach anything the account can — the UI says so). null = not decided yet (init decides).
//  - asked: the macOS standard folders (downloads / desktop / documents) whose system prompt was triggered once
//    from the 授权 page. Reading one of them again no longer prompts, so their status can be read quietly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_FOLDERS = 50;
const SYSTEM_FOLDERS = ['downloads', 'desktop', 'documents'];
const LOCAL_DEFAULTS = { folders: null, allowCommands: null, asked: [] };

const expandHome = (p, home = os.homedir()) => (p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p);

// One folder as stored: absolute, `..` and `.` collapsed, no trailing separator. Null when not usable.
function normalizeFolder(p, { home = os.homedir() } = {}) {
  if (typeof p !== 'string') return null;
  const s = expandHome(p.trim(), home);
  if (!s || s.includes('\0') || !path.isAbsolute(s)) return null;
  return path.resolve(s);
}

// Is `p` the folder `root` or somewhere below it? Both absolute and resolved.
function isInside(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The stored list: usable entries only, no repeats, no folder that another entry already contains, at most
// MAX_FOLDERS, in the order they were added. null stays null (no limit).
function normalizeFolders(list, opts = {}) {
  if (list === null) return null;
  if (!Array.isArray(list)) return [];
  const clean = [];
  for (const raw of list) {
    const f = normalizeFolder(raw, opts);
    if (f && !clean.includes(f)) clean.push(f);
  }
  return clean.filter((f) => !clean.some((o) => o !== f && isInside(f, o))).slice(0, MAX_FOLDERS);
}

function normalizeLocal(raw) {
  const l = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    folders: l.folders === undefined ? null : normalizeFolders(l.folders),
    allowCommands: typeof l.allowCommands === 'boolean' ? l.allowCommands : null,
    asked: [...new Set((Array.isArray(l.asked) ? l.asked : []).filter((k) => SYSTEM_FOLDERS.includes(k)))],
  };
}

// The first run after this list existed: owners who already had 本机能力 on keep what they had (no limit,
// commands allowed) until they add a folder; everyone else starts strict (no folder, no commands).
function decideLocal(local, { localOn }) {
  const l = normalizeLocal(local);
  const legacy = l.folders === null && l.allowCommands === null && !!localOn;
  return {
    ...l,
    folders: l.folders === null && !legacy ? [] : l.folders,
    allowCommands: l.allowCommands === null ? legacy : l.allowCommands,
  };
}

const addFolders = (local, paths) => {
  const l = normalizeLocal(local);
  return { ...l, folders: normalizeFolders([...(l.folders || []), ...(Array.isArray(paths) ? paths : [paths])]) };
};
const removeFolder = (local, p) => {
  const l = normalizeLocal(local);
  const f = normalizeFolder(p);
  return { ...l, folders: (l.folders || []).filter((x) => x !== f) };
};

// What a turn's local tools may touch. null = no limit (the old behaviour).
// `extraRead`: paths the owner handed her this turn (dropped onto her / 读本机文件): readable, not writable.
function toolScope(local, { extraRead = [] } = {}) {
  const l = normalizeLocal(local);
  if (l.folders === null) return null;
  return { folders: l.folders, allowCommands: l.allowCommands === true, extraRead: normalizeFolders(extraRead) };
}

// A path's real location: symlinks resolved. A path that does not exist yet (write_file to a new file) is the
// real location of its nearest existing parent plus the rest, so a symlinked parent cannot lead outside.
async function realLocation(p) {
  let cur = p;
  const rest = [];
  for (;;) {
    try {
      return path.join(await fs.promises.realpath(cur), ...rest);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const realRoots = (folders) => Promise.all(folders.map((f) => realLocation(f).catch(() => f)));

class OutsideError extends Error {
  constructor(message) {
    super(message);
    this.code = 'EOUTSIDE';
  }
}

// The absolute path a tool may use, or an OutsideError the model reads back. `write`: write_file / a command's cwd.
async function checkPath(p, scope, { write = false, home = os.homedir() } = {}) {
  const s = expandHome(String(p || '').trim(), home);
  if (scope && !scope.folders.length && !(scope.extraRead || []).length) throw new OutsideError('the owner has not allowed any folder yet; ask them to add one in 设置 → LobeHub 与本机 → 文件夹与系统权限');
  if (!s) throw new Error('path is required');
  if (!scope) return path.resolve(s);
  if (!path.isAbsolute(s)) throw new OutsideError('use an absolute path inside one of the folders the owner allowed');
  const abs = path.resolve(s);
  const real = await realLocation(abs);
  const roots = await realRoots(scope.folders);
  if (roots.some((r) => isInside(real, r))) return abs;
  if (!write && (await realRoots(scope.extraRead || [])).some((r) => isInside(real, r))) return abs;
  throw new OutsideError(`path is outside the folders the owner allowed (${scope.folders.join(', ') || 'none'})`);
}

// One line for the tools' instructions: where she may go.
function scopeHint(scope) {
  if (!scope) return '';
  const where = scope.folders.length ? `Only these folders on the owner's computer can be read or written: ${scope.folders.join(', ')}.` : 'The owner has not allowed any folder yet: files cannot be read or written until they add one in 设置 → LobeHub 与本机.';
  const extra = scope.extraRead && scope.extraRead.length ? ` The owner also handed you these to read this turn: ${scope.extraRead.join(', ')}.` : '';
  return `${where}${extra}`;
}

module.exports = { MAX_FOLDERS, SYSTEM_FOLDERS, LOCAL_DEFAULTS, normalizeFolder, normalizeFolders, normalizeLocal, decideLocal, addFolders, removeFolder, isInside, toolScope, realLocation, checkPath, scopeHint, OutsideError };
