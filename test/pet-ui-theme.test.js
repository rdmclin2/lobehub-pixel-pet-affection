'use strict';
// The pet window's interface (bubble, HUD, chat box, menus, toast) uses the LobeHub tokens like the admin
// window (.agents/ux/lobe-design-rules.md R-04); only the character art keeps raw colours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('src/renderer/index.html');
const css = read('src/renderer/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
// 她的面板: its own window (src/renderer/panel/), same tokens and base stylesheet
const panelHtml = read('src/renderer/panel/panel.html');
const panelCss = read('src/renderer/panel/panel.css').replace(/\/\*[\s\S]*?\*\//g, '');

// every rule of a selector (the stylesheet is one rule per line, with a few continued on the next line)
const rulesFor = (sel, sheet = css) => {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(sheet))) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.includes(sel)) out.push(m[2]);
  }
  return out.join(';');
};

test('index.html loads the LobeHub tokens before the pet stylesheet', () => {
  const tokens = html.indexOf('href="design/lobe-tokens.css"');
  const style = html.indexOf('href="style.css"');
  assert.ok(tokens > 0 && style > tokens, 'design/lobe-tokens.css is linked before style.css');
  assert.ok(fs.existsSync(path.join(ROOT, 'src/renderer/design/lobe-tokens.css')));
});

test('interface pieces read --lobe-* tokens, not the old pixel palette', () => {
  const ui = ['body', '.btn', '.btn.primary', 'input, select, textarea', '.bubble', '.bubble-tail', '.chat-row', '.popup', '.popup .btn',
    '.unlock-toast', '.toast-title',
    '.stop-btn', '.zone-hint', '.mic-status', '.new-dot', '#age-gate'];
  for (const sel of ui) {
    const body = sel.includes(',') ? rulesFor(sel.split(',')[0].trim()) : rulesFor(sel);
    assert.ok(body, `${sel} has a rule`);
    assert.match(body, /var\(--(lobe|pet)-/, `${sel} uses tokens`);
    assert.doesNotMatch(body, /#2b2233|#f4efe6|#ffd23f|#ffe9a8|#fff6d6|Courier New/i, `${sel} has no pixel-palette colour`);
    assert.doesNotMatch(body, /\d+px \d+px 0 #/, `${sel} has no hard pixel drop shadow`);
  }
  for (const sel of ['.pet-panel', '.pp-tile', '.pp-foot', '.need-bar', '.aff-row', '.pet-panel .meta', '.pp-foods']) {
    const body = rulesFor(sel, panelCss);
    assert.ok(body, `panel ${sel} has a rule`);
    assert.match(body, /var\(--(lobe|pet)-/, `panel ${sel} uses tokens`);
    assert.doesNotMatch(body, /#[0-9a-f]{3,6}\b|Courier New/i, `panel ${sel} has no raw colour`);
  }
  assert.doesNotMatch(css, /Courier New/);
  // project aliases never redefine LobeHub tokens (lobe-design D-07)
  assert.doesNotMatch(css, /^\s*--lobe-[\w-]+\s*:/m);
});

test('dark mode comes from the token file (OS appearance), styles do not branch on it', () => {
  const tokens = read('src/renderer/design/lobe-tokens.css');
  assert.match(tokens, /\[data-theme='dark'\]/);
  assert.match(tokens, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /prefers-color-scheme/, 'style.css itself has no theme branches');
  // <html data-theme> follows the OS, or the owner's settings.ui.theme when it pins light / dark (as the admin window does)
  const app = read('src/renderer/app.js');
  assert.match(app, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(app, /document\.documentElement\.dataset\.theme = /);
  assert.match(app, /appearance\.set\(st && st\.ui && st\.ui\.theme\)/);
});

test('HUD meters use semantic token colours; inline icons do not swallow toolbar clicks', () => {
  const app = read('src/renderer/app.js');
  const bar = app.match(/function barColor[\s\S]*?\n}/)[0];
  assert.match(bar, /var\(--lobe-color-success\)/);
  assert.match(bar, /var\(--lobe-color-warning\)/);
  assert.match(bar, /var\(--lobe-color-error\)/);
  assert.doesNotMatch(bar, /#[0-9a-f]{3,6}/i);
  // the toolbar picks its action from e.target.dataset: an <svg> inside a button must let the click through
  assert.match(rulesFor('.ico'), /pointer-events:\s*none/);
  const gear = panelHtml.match(/<button[^>]*data-act="settings"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert.match(gear, /<svg class="ico"/);
  // the selectors e2e and app.js rely on are still there: her window, and her panel
  for (const id of ['bubble', 'chat-input', 'chat-send', 'chat-mic', 'attach-btn', 'dance-menu', 'unlock-toast', 'toast-close', 'toast-open', 'stop-btn']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const id of ['btn-settings', 'food-menu', 'aff-stage', 'bar-affection', 'bar-hunger']) assert.match(panelHtml, new RegExp(`id="${id}"`), id);
});

test('her panel (right click on her): its own window — one card, state on top, actions below, split by hairlines', () => {
  const body = panelHtml.match(/<div id="pet-panel" class="pet-panel"[^>]*>([\s\S]*?)<script/)[1];
  for (const id of ['status-panel', 'pp-name', 'pp-char', 'aff-stage', 'aff-row', 'bar-affection', 'aff-num', 'meta', 'bars', 'bar-hunger', 'bar-mood', 'bar-energy', 'val-hunger', 'val-mood', 'val-energy', 'toolbar', 'food-menu', 'btn-mute', 'btn-dance', 'btn-reset', 'btn-settings', 'btn-quit']) assert.match(body, new RegExp(`id="${id}"`), `#${id} is in the panel`);
  assert.ok(body.indexOf('id="status-panel"') < body.indexOf('id="toolbar"'), 'her state comes before what to do');
  for (const act of ['feed', 'play', 'sleep', 'chat']) assert.match(body, new RegExp(`class="pp-tile" data-act="${act}"[^>]*><svg class="ico"`), `${act} is a tile with an icon`);
  // same tokens and base stylesheet as her window; a strict CSP (no remote anything)
  assert.match(panelHtml, /href="\.\.\/design\/lobe-tokens\.css"[\s\S]*href="\.\.\/style\.css"[\s\S]*href="panel\.css"/);
  assert.match(panelHtml, /Content-Security-Policy" content="default-src 'self'/);
  // her window keeps none of it: hovering shows no status card or toolbar any more
  for (const gone of ['id="status-panel"', 'id="toolbar"', 'data-act=', 'id="food-menu"']) assert.ok(!html.includes(gone), `${gone} left her window`);
  const p = rulesFor('.pet-panel', panelCss);
  for (const prop of ['background', 'border', 'border-radius', 'box-shadow']) assert.match(p, new RegExp(`(^|;)\\s*${prop}:`), `.pet-panel has its own ${prop}`);
  assert.match(rulesFor('.pp-actions', panelCss), /border-top:\s*1px solid var\(--pet-line-soft\)/, 'state and actions are split by a hairline');
  assert.match(rulesFor('.pp-tile:hover', panelCss), /background:\s*var\(--lobe-color-fill-tertiary\)/, 'tiles hover as a quiet fill');
  for (const sel of ['.aff-row', '.pet-panel .meta', '.need']) assert.doesNotMatch(rulesFor(sel, panelCss), /background:|box-shadow:/, `${sel} has no own surface`);
  assert.match(rulesFor('.pet-panel .meta', panelCss), /text-overflow:\s*ellipsis/, 'a long line is cut, not overflowing');
  // app.js: a right click toggles it, a long press opens it; the buttons come back as panel-act
  const app = read('src/renderer/app.js');
  assert.match(app, /togglePetPanel\('right-click'\)/);
  assert.match(app, /onMenu: \(\) => openPetPanel\('long-press'\)/);
  assert.match(app, /window\.pet\.panel\.onAct\(/);
});
