'use strict';
// 商店 → 小游戏 → 检查更新 (T-13654 D7): the toast names what can be updated by kind — a wallpaper is not a mini game.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { updatesText } = require('../src/core/store-updates-text');

const row = (kind, state = 'update') => ({ kind, state });

test('updates by kind: 壁纸 / 小游戏 / both; nothing to update → null', () => {
  assert.equal(updatesText([row('wallpaper')]), '有 1 个壁纸可以更新');
  assert.equal(updatesText([row('wallpaper'), row('wallpaper')]), '有 2 个壁纸可以更新');
  assert.equal(updatesText([row('game'), row('game')]), '有 2 个小游戏可以更新');
  assert.equal(updatesText([row('game'), row('wallpaper'), row('game', 'installed')]), '有 1 个小游戏和 1 个壁纸可以更新');
  assert.equal(updatesText([row(undefined)]), '有 1 个小游戏可以更新', 'a row from before kinds counts as a mini game');
  assert.equal(updatesText([row('wallpaper', 'installed'), row('game', 'remote')]), null);
  assert.equal(updatesText([]), null);
  assert.equal(updatesText(null), null);
});

test('the store page uses it (no hard-coded 「个小游戏可以更新」 left)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'admin', 'src', 'console', 'pages', 'StoreGames.tsx'), 'utf8');
  assert.match(src, /StoreUpdatesText\.updatesText\(r\.games\)/);
  assert.doesNotMatch(src, /个小游戏可以更新/);
});
