'use strict';
// 版本与更新 checks for a new version on its own when the user opens it (T-6161). Opening it again soon after
// (switching pages back and forth) must not start another check, nor may one while a check or a download is
// under way, nor in a build that does not update itself. `lastAutoAt` is when this settings window last
// started such a check; `state` is Updater#state (src/main/updater.js).
// Pure and Electron-free: required by the tests, bundled into the settings window by Vite.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetUpdateAuto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COOLDOWN_MS = 10 * 60 * 1000;
  // already on its way (checking / downloading / ready to install) or never updates (dev run): nothing to do
  const SKIP = ['checking', 'downloading', 'ready', 'disabled'];

  function shouldAutoCheck(state, { now, lastAutoAt = 0 } = {}) {
    const st = state || {};
    if (SKIP.includes(st.status)) return false;
    const last = Math.max(Number(st.checkedAt) || 0, Number(lastAutoAt) || 0);
    return !last || now - last >= COOLDOWN_MS;
  }

  return { COOLDOWN_MS, shouldAutoCheck };
});
