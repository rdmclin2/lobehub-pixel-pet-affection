# vendor/pixi

The 2D engine of the 小游戏 window (`src/renderer/game/`, docs/mini-games.md). Loaded by `game.html` only.

| file | what | version | source | license |
| --- | --- | --- | --- | --- |
| `pixi.min.js` | PixiJS browser build (IIFE, sets `window.PIXI`) | 8.22.0 | npm `pixi.js@8.22.0` `dist/pixi.min.js` | MIT — `pixi.LICENSE` |
| `unsafe-eval.min.js` | PixiJS's no-`eval` shader / uniform paths, so the page keeps a CSP without `'unsafe-eval'` | 8.22.0 | npm `pixi.js@8.22.0` `dist/packages/unsafe-eval.min.js` | MIT |

Update: `npm i -D pixi.js@<version>` and copy the two files from `node_modules/pixi.js/dist/` here.
(`src/renderer/vendor/live2d/pixi.min.js` is a different, older PixiJS that the Live2D runtime needs; the two are
never on the same page.)
