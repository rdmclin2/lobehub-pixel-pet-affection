'use strict';

// 授权 (T-5075, docs/permissions.md): the system permissions the pet asks for one at a time, plus the folders
// her local tools may use (core/ai-folders.js). The onboarding's 授权 page and 设置 → LobeHub 与本机 →
// 文件夹与系统权限 both read status() and call the actions below.
//
// macOS only has prompts for these:
//  - 麦克风: getMediaAccessStatus reads the state quietly; askForMediaAccess asks (once; after a refusal only
//    System Settings can change it).
//  - 下载 / 桌面 / 文稿: no API reads the state without prompting, so it is "unknown" until the owner presses
//    授权 here; then the folder is read once (that read is what shows the system prompt). After that a read no
//    longer prompts, so the folders asked before (settings.local.asked) are checked quietly on every status().
// Nothing else is asked for (no accessibility, screen recording, notifications). Linux / Windows have no such
// prompts: status() reports `mac: false` and the UI shows the folder list only.
//
// Electron-free: main.js passes systemPreferences / shell / dialog / getPath; the tests and the e2e pass fakes.

const fs = require('node:fs');
const path = require('node:path');
const aiFolders = require('../core/ai-folders');

const FOLDER_LABELS = { downloads: '下载', desktop: '桌面', documents: '文稿' };
const SETTINGS_URL = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  folders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
};

// A folder read that the system refused (TCC answers EPERM; EACCES on some versions).
const refused = (e) => e && (e.code === 'EPERM' || e.code === 'EACCES');

function createPermissions({ service, platform = process.platform, systemPreferences = null, shell = null, pickFolders = async () => [], getPath = () => null, readdir = (p) => fs.promises.readdir(p) }) {
  const mac = platform === 'darwin';

  const micStatus = () => {
    if (!mac) return null;
    if (!systemPreferences || !systemPreferences.getMediaAccessStatus) return 'unknown';
    return systemPreferences.getMediaAccessStatus('microphone'); // granted | denied | restricted | not-determined
  };

  const folderPath = (id) => {
    try {
      return getPath(id) || null;
    } catch {
      return null;
    }
  };

  // granted | denied | unknown (never asked from here: reading it now could prompt) | missing
  async function folderStatus(id, asked) {
    const p = folderPath(id);
    if (!p) return 'missing';
    if (!asked.includes(id)) return 'unknown';
    try {
      await readdir(p);
      return 'granted';
    } catch (e) {
      return refused(e) ? 'denied' : e.code === 'ENOENT' ? 'missing' : 'unknown';
    }
  }

  async function status() {
    const local = service.settings.local;
    const folders = mac
      ? await Promise.all(aiFolders.SYSTEM_FOLDERS.map(async (id) => {
        const p = folderPath(id);
        return { id, label: FOLDER_LABELS[id], path: p, status: await folderStatus(id, local.asked), inList: !!p && (local.folders || []).includes(aiFolders.normalizeFolder(p)) };
      }))
      : [];
    return {
      ok: true,
      platform,
      mac,
      mic: micStatus(),
      folders,
      localOn: !!(service.pet && service.pet.localAbilities),
      local: { folders: local.folders || [], limited: local.folders !== null, allowCommands: local.allowCommands === true },
    };
  }

  // 授权: 'microphone', or one of the standard folders. A folder that opens is added to her list as well
  // (it can be removed again); one that does not is recorded as asked, so its refusal shows from now on.
  async function request(kind) {
    if (!mac) return { ...(await status()), ok: false, reason: 'not-mac' };
    if (kind === 'microphone') {
      const st = micStatus();
      let granted = st === 'granted';
      if (st === 'not-determined' && systemPreferences && systemPreferences.askForMediaAccess) granted = await systemPreferences.askForMediaAccess('microphone');
      return { ...(await status()), result: granted ? 'granted' : micStatus() || 'denied' };
    }
    if (!aiFolders.SYSTEM_FOLDERS.includes(kind)) return { ...(await status()), ok: false, reason: 'unknown-kind' };
    const p = folderPath(kind);
    if (!p) return { ...(await status()), ok: false, reason: 'missing' };
    let result;
    try {
      await readdir(p); // the read that shows the system prompt (the first time)
      result = 'granted';
    } catch (e) {
      result = refused(e) ? 'denied' : 'error';
    }
    service.setAiFolders({ asked: kind, add: result === 'granted' ? [p] : null });
    return { ...(await status()), result };
  }

  // After a refusal only System Settings can change it: the right pane.
  async function openSettings(kind) {
    const url = kind === 'microphone' ? SETTINGS_URL.microphone : SETTINGS_URL.folders;
    if (!mac) return { ok: false, reason: 'not-mac' };
    if (shell) await shell.openExternal(url);
    return { ok: true, url };
  }

  // 添加文件夹…: the system folder picker (several at once).
  async function addFolders() {
    const picked = (await pickFolders()).filter((p) => typeof p === 'string' && p);
    if (picked.length) service.setAiFolders({ add: picked });
    return { ...(await status()), added: picked.map((p) => aiFolders.normalizeFolder(p)).filter(Boolean) };
  }

  async function setFolders({ remove, allowCommands } = {}) {
    service.setAiFolders({ remove: typeof remove === 'string' ? remove : null, allowCommands: typeof allowCommands === 'boolean' ? allowCommands : undefined });
    return status();
  }

  return { status, request, openSettings, addFolders, setFolders };
}

// E2E (test mode only): macOS as the pet would see it, without a Mac. `spec` (PIXELPET_E2E_PERMS, JSON):
//   { mic: 'not-determined' | 'granted' | 'denied', micAnswer: true | false,
//     folders: { downloads: 'grant' | 'deny', … }, home: '<dir with Downloads / Desktop / Documents>' }
// A folder answers its first read with its entry ('grant' / 'deny'), and keeps that answer.
function fakeMac(spec = {}) {
  let mic = spec.mic || 'not-determined';
  const answers = { ...(spec.folders || {}) };
  const home = spec.home || null;
  const dirs = { downloads: 'Downloads', desktop: 'Desktop', documents: 'Documents' };
  const opened = [];
  return {
    opened,
    systemPreferences: {
      getMediaAccessStatus: () => mic,
      askForMediaAccess: async () => {
        if (mic === 'not-determined') mic = spec.micAnswer === false ? 'denied' : 'granted';
        return mic === 'granted';
      },
    },
    shell: { openExternal: async (u) => { opened.push(u); } },
    getPath: (id) => (home && dirs[id] ? path.join(home, dirs[id]) : null),
    readdir: async (p) => {
      const id = Object.keys(dirs).find((k) => home && path.join(home, dirs[k]) === p);
      if (id && answers[id] === 'deny') throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      return fs.promises.readdir(p);
    },
  };
}

module.exports = { createPermissions, fakeMac, SETTINGS_URL, FOLDER_LABELS };
