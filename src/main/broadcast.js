'use strict';

// Who hears a settings / view change (docs/admin-console-design.md §5.4): every pet window (the companion
// and visitors, `pets`) and the settings window. The settings window is kept out of `pets` so it never takes
// part in collisions or `peers`; this is the one place both are reached. Electron-free (tests pass fakes).

function createBroadcast({ pets, admin }) {
  const alive = (w) => w && !(typeof w.isDestroyed === 'function' && w.isDestroyed());
  return function broadcast(channel, payload) {
    let n = 0;
    for (const p of pets.values()) if (alive(p.win)) { p.win.webContents.send(channel, payload); n += 1; }
    const a = typeof admin === 'function' ? admin() : admin;
    if (a && a.alive) { a.send(channel, payload); n += 1; }
    return n;
  };
}

module.exports = { createBroadcast };
