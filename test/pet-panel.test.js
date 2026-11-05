'use strict';
// 她的面板 (src/main/pet-panel.js): where its window goes beside her (core/pet-panel.js placeBeside).
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeBeside } = require('../src/core/pet-panel');

const area = { x: 0, y: 0, width: 1280, height: 1000 };
const size = { w: 264, h: 234 };
const PAD = 12;
const inside = (b) => b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;
// the card (the window minus its shadow room) and her box do not overlap
const clear = (b, her) => {
  const c = { x: b.x + PAD, y: b.y + PAD, r: b.x + b.width - PAD, b: b.y + b.height - PAD };
  return c.r <= her.x || c.x >= her.x + her.width || c.b <= her.y || c.y >= her.y + her.height;
};

test('beside her on the right, the card level with her feet', () => {
  const her = { x: 400, y: 600, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area, pad: PAD });
  assert.equal(b.side, 'right');
  assert.equal(b.x + PAD, her.x + her.width + 8, '8 px gap between her and the card');
  assert.equal(b.y + b.height - PAD, her.y + her.height, 'card bottom at her feet');
  assert.ok(inside(b) && clear(b, her));
});

test('at the right edge of the screen it opens on her left', () => {
  const her = { x: 1280 - 160, y: 700, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area, pad: PAD });
  assert.equal(b.side, 'left');
  assert.equal(b.x + b.width - PAD, her.x - 8);
  assert.ok(inside(b) && clear(b, her));
});

test('near the top of the screen it is pushed down, never off screen', () => {
  const her = { x: 300, y: 10, width: 150, height: 120 };
  const b = placeBeside({ anchor: her, size, area, pad: PAD });
  assert.ok(inside(b));
  assert.ok(b.y >= area.y);
});

test('a screen too narrow for either side: over her, centred, still inside', () => {
  const small = { x: 0, y: 0, width: 400, height: 600 };
  const her = { x: 120, y: 300, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area: small, pad: PAD });
  assert.equal(b.side, 'over');
  assert.ok(b.x >= 0 && b.x + b.width <= 400);
});

test('a second screen: the coordinates of that screen', () => {
  const right = { x: 1280, y: 0, width: 1920, height: 1080 };
  const her = { x: 1280 + 1700, y: 800, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area: right, pad: PAD });
  assert.equal(b.side, 'left');
  assert.ok(b.x >= right.x && b.x + b.width <= right.x + right.width);
});

// 和她聊天 (T-6162): the chat box is in her panel; main hands what was typed to her window (onAct chat / draft)
test('the panel chat box: a message goes to her window trimmed and capped, an empty one goes nowhere, the panel stays', () => {
  const { PetPanel } = require('../src/main/pet-panel');
  const got = [];
  const p = new PetPanel({ onAct: (m) => got.push(m) });
  let closed = 0;
  p.close = () => { closed += 1; return true; };
  p.chat({ text: '  今天好累呀\n想听你讲个故事  ' });
  p.chat({ text: '   \n ' });
  p.chat({});
  p.chat({ text: 'x'.repeat(2500) });
  assert.deepEqual(got.map((m) => m.act), ['chat', 'chat']);
  assert.equal(got[0].text, '今天好累呀\n想听你讲个故事', 'line breaks kept, ends trimmed');
  assert.equal(got[1].text.length, 2000, 'one message is at most 2000 characters');
  assert.equal(closed, 0, 'sending does not close it: she starts thinking, and that closes it (app.js setThinking)');
  assert.deepEqual(p.acts, ['chat', 'chat']);
});

test('the panel chat box: the draft goes to her window as typed (插个嘴 decides there), and is not counted as a press', () => {
  const { PetPanel } = require('../src/main/pet-panel');
  const got = [];
  const p = new PetPanel({ onAct: (m) => got.push(m) });
  p.draft({ text: '在写' });
  p.draft({ text: '' });
  assert.deepEqual(got, [{ act: 'draft', text: '在写' }, { act: 'draft', text: '' }]);
  assert.deepEqual(p.acts, []);
});

test('the panel page: no 聊天 tile, a textarea chat box in the card with its send button', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'panel.html'), 'utf8');
  assert.ok(!html.includes('data-act="chat"'));
  assert.match(html, /<textarea id="pp-chat-input"[^>]*maxlength="2000"/);
  assert.match(html, /<button id="pp-chat-send" type="submit"/);
});

test('the panel chat box: a message her window did not send (she was busy) goes back into the box', () => {
  const { PetPanel } = require('../src/main/pet-panel');
  const p = new PetPanel();
  const sent = [];
  p.win = { isDestroyed: () => false, webContents: { send: (ch, m) => sent.push([ch, m]) } };
  p.restore({ text: '刚才那句' });
  p.restore({ text: '' });
  p.restore({ text: 'y'.repeat(2100) });
  assert.deepEqual(sent.map(([ch]) => ch), ['pet-panel:restore', 'pet-panel:restore']);
  assert.equal(sent[0][1].text, '刚才那句');
  assert.equal(sent[1][1].text.length, 2000);
  p.win = null;
  assert.doesNotThrow(() => p.restore({ text: 'no window yet' }));
});
