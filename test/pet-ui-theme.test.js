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

// every rule of a selector (the stylesheet is one rule per line, with a few continued on the next line)
const rulesFor = (sel) => {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
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
    '.unlock-toast', '.toast-title', '.status-panel', '.bars', '.aff-row', '.hud .meta',
    '.stop-btn', '.zone-hint', '.mic-status', '.new-dot', '#age-gate'];
  for (const sel of ui) {
    const body = sel.includes(',') ? rulesFor(sel.split(',')[0].trim()) : rulesFor(sel);
    assert.ok(body, `${sel} has a rule`);
    assert.match(body, /var\(--(lobe|pet)-/, `${sel} uses tokens`);
    assert.doesNotMatch(body, /#2b2233|#f4efe6|#ffd23f|#ffe9a8|#fff6d6|Courier New/i, `${sel} has no pixel-palette colour`);
    assert.doesNotMatch(body, /\d+px \d+px 0 #/, `${sel} has no hard pixel drop shadow`);
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
  const gear = html.match(/<button[^>]*data-act="settings"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert.match(gear, /<svg class="ico"/);
  // the selectors e2e and app.js rely on are still there
  for (const id of ['bubble', 'chat-input', 'chat-send', 'chat-mic', 'attach-btn', 'btn-settings', 'food-menu', 'unlock-toast', 'toast-close', 'toast-open', 'stop-btn', 'aff-stage', 'bar-affection', 'bar-hunger']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
});

test('status bar is one panel (T-2726): needs, affection and the name line share one surface, split by hairlines', () => {
  const panel = html.match(/<div id="status-panel" class="status-panel">([\s\S]*?)<div id="toolbar"/);
  assert.ok(panel, '#status-panel sits in the HUD, before the toolbar');
  for (const id of ['bars', 'aff-row', 'meta']) assert.match(panel[1], new RegExp(`id="${id}"`), `#${id} is inside the panel`);
  const p = rulesFor('.status-panel');
  for (const prop of ['background', 'border', 'border-radius', 'box-shadow']) assert.match(p, new RegExp(`(^|;)\\s*${prop}:`), `.status-panel has its own ${prop}`);
  assert.match(p, /max-width:\s*calc\(100% - /, 'never wider than the window');
  assert.match(rulesFor('.status-panel > * + *'), /border-top:\s*1px solid var\(--pet-line-soft\)/, 'rows are split by a hairline');
  // the rows no longer draw their own pill / card
  for (const sel of ['.bars', '.aff-row', '.hud .meta']) assert.doesNotMatch(rulesFor(sel), /background:|box-shadow:|border-radius:/, `${sel} has no own surface`);
  assert.match(rulesFor('.hud .meta'), /text-overflow:\s*ellipsis/, 'a long name line is cut, not overflowing');
});
