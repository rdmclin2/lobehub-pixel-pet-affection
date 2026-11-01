# vendor/vrm

The 3D runtime for VRM 角色包 (`kind: "vrm"`, docs/pet-packs.md), loaded by `src/renderer/vrm.js` the first
time a VRM look is shown (never with the page itself).

| file | what | version | source | license |
| --- | --- | --- | --- | --- |
| `three-vrm.min.js` | three.js (WebGLRenderer, scene, camera, lights, math) + `GLTFLoader` + `@pixiv/three-vrm` (VRM 1.0 / 0.x loader, MToon, expressions, look-at, SpringBone, VRMUtils), one minified IIFE that sets `window.PetVrmRuntime` | three 0.187.0 (r187), @pixiv/three-vrm 3.5.5, @pixiv/three-vrm-animation 3.5.5 | npm `three@0.187.0`, `@pixiv/three-vrm@3.5.5` (https://github.com/mrdoob/three.js, https://github.com/pixiv/three-vrm) | MIT — `three.LICENSE`, `three-vrm.LICENSE` |

Rebuild (only to change the versions; pinned in the script): `node scripts/build-vrm-vendor.js`. It installs
the pinned packages into a temporary folder, bundles them with esbuild 0.28.2 and copies the licenses here.
`@pixiv/three-vrm-animation` 3.5.5 (MIT, `three-vrm-animation.LICENSE`) is included for a pack's optional idle loop (`vrm.idle`, a `.vrma`); the app's own moves stay procedural (src/core/vrm-motion.js) and are laid on top.
