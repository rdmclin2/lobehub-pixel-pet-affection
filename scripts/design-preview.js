'use strict';
// Design-system preview window: opens the built admin bundle (src/admin-ui/index.html#/design/*) in Electron
// with the same webPreferences the settings window will use (sandbox, contextIsolation, no Node).
//
//   npm run design:preview                         # interactive, appearance follows the OS
//   electron scripts/design-preview.js --theme=dark --page=/design/form
//   electron scripts/design-preview.js --shots=out/design   # capture every page, light + dark, then quit
//   electron scripts/design-preview.js --index=dist/linux-unpacked/resources/app.asar/src/admin-ui/index.html --shots=…
//
// Every request that is not file:// / data: / blob: / devtools is cancelled and reported, so the preview
// also proves the bundle runs offline under its CSP. Console errors are reported too.
const { app, BrowserWindow, nativeTheme, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PAGES = ['colors', 'typography', 'layout', 'motion', 'controls', 'display', 'form', 'feedback'].map((p) => `/design/${p}`);

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const theme = arg('theme', 'system');
const page = arg('page', PAGES[0]);
const shots = arg('shots');
// --index=dist/linux-unpacked/resources/app.asar/src/admin-ui/index.html checks the packaged copy
const INDEX = path.resolve(arg('index', path.join(__dirname, '..', 'src', 'admin-ui', 'index.html')));

const report = { blocked: [], consoleErrors: [], shots: [] };
const LOCAL = /^(file|data|blob|devtools|chrome-extension):/;

function createWindow() {
  return new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'Pixel Pet 设置 · 设计系统',
    show: !shots,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f8f8f8', // = --lobe-color-bg-layout, avoids a white flash
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
}

async function capture(win) {
  fs.mkdirSync(shots, { recursive: true });
  for (const appearance of ['light', 'dark']) {
    nativeTheme.themeSource = appearance;
    for (const p of PAGES) {
      await win.loadFile(INDEX, { hash: p });
      await win.webContents.executeJavaScript(
        `new Promise((r) => { const t0 = Date.now(); (function w() { const el = document.querySelector('[data-design-page="${p}"]'); if ((el && document.documentElement.dataset.theme === '${appearance}') || Date.now() - t0 > 8000) setTimeout(r, 400); else setTimeout(w, 50); })(); })`,
      );
      const facts = await win.webContents.executeJavaScript(
        `({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, h: document.documentElement.scrollHeight })`,
      );
      // grow the window to the full page height so one image holds the whole page
      win.setContentSize(1200, Math.min(Math.max(facts.h, 820), 4000));
      await new Promise((r) => setTimeout(r, 300));
      const img = await win.webContents.capturePage();
      const file = path.join(shots, `${appearance}-${p.split('/').pop()}.png`);
      fs.writeFileSync(file, img.toPNG());
      report.shots.push({ file: path.relative(process.cwd(), file), page: p, ...facts });
      win.setContentSize(1200, 820);
    }
  }
  fs.writeFileSync(path.join(shots, 'preview-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ shots: report.shots.length, blocked: report.blocked, consoleErrors: report.consoleErrors }, null, 2));
}

app.whenReady().then(async () => {
  if (!fs.existsSync(INDEX)) {
    console.error(`missing ${INDEX} — run \`npm run build:admin\` first`);
    app.exit(1);
    return;
  }
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    if (LOCAL.test(details.url)) return cb({});
    report.blocked.push(details.url);
    cb({ cancel: true });
  });
  if (theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme;
  const win = createWindow();
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    if (level === 'error' || level === 3) report.consoleErrors.push(e.message ?? e.params?.message);
  });
  if (shots) {
    try {
      await capture(win);
    } finally {
      app.exit(report.blocked.length || report.consoleErrors.length ? 1 : 0);
    }
    return;
  }
  // pin the page too (?theme=): nativeTheme only reaches prefers-color-scheme once the renderer is up
  await win.loadFile(INDEX, { hash: page, ...(theme === 'light' || theme === 'dark' ? { search: `theme=${theme}` } : {}) });
});

app.on('window-all-closed', () => app.quit());
