'use strict';

// 她的面板 (src/main/pet-panel.js): where its window goes. Electron-free so the tests can try every screen edge.
//   anchor  her picture's box on the screen { x, y, width, height }
//   size    the panel window { w, h } (its card plus `pad` of transparent room for the shadow on each side)
//   area    the screen's work area { x, y, width, height }
// Beside her on the right, the card's bottom level with her feet; no room on the right: on the left; no room on
// either side (a narrow screen): over her, centred. Always kept inside the work area.
function placeBeside({ anchor, size, area, gap = 8, pad = 0, margin = 4 }) {
  const w = Math.min(size.w, area.width - 2 * margin);
  const h = Math.min(size.h, area.height - 2 * margin);
  const right = anchor.x + anchor.width + gap - pad;
  const left = anchor.x - gap + pad - w;
  let side = 'right';
  let x = right;
  if (right + w > area.x + area.width - margin) {
    if (left >= area.x + margin) { side = 'left'; x = left; } else { side = 'over'; x = anchor.x + anchor.width / 2 - w / 2; }
  }
  let y = anchor.y + anchor.height + pad - h;
  x = Math.max(area.x + margin, Math.min(x, area.x + area.width - margin - w));
  y = Math.max(area.y + margin, Math.min(y, area.y + area.height - margin - h));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), side };
}

module.exports = { placeBeside };
