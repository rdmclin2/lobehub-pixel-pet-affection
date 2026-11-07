'use strict';
// 商店 → 小游戏 → 检查更新: the toast that says what can be updated, by kind (T-13654 D7) — a wallpaper is not a
// mini game: 「有 1 个壁纸可以更新」, 「有 2 个小游戏可以更新」, 「有 1 个小游戏和 1 个壁纸可以更新」. Rows are the store's
// games (core/game-index.js storeRows: { state, kind }); null when nothing can be updated.
// Pure and Electron-free: required by the tests, bundled into the settings window by Vite.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetStoreUpdatesText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NOUN = { game: '小游戏', wallpaper: '壁纸' };

  function updatesText(rows) {
    const ups = (Array.isArray(rows) ? rows : []).filter((r) => r && r.state === 'update');
    if (!ups.length) return null;
    const count = { game: 0, wallpaper: 0 };
    for (const r of ups) count[r.kind === 'wallpaper' ? 'wallpaper' : 'game'] += 1;
    const parts = ['game', 'wallpaper'].filter((k) => count[k] > 0).map((k) => `${count[k]} 个${NOUN[k]}`);
    return `有 ${parts.join('和 ')}可以更新`;
  }

  return { updatesText };
});
