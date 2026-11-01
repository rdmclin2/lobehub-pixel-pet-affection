#!/usr/bin/env node
'use strict';

// Rebuilds src/renderer/vendor/vrm/: three.js + @pixiv/three-vrm as one browser script (an IIFE that sets
// window.PetVrmRuntime) and their licenses. The renderer (src/renderer/vrm.js) loads it the first time a
// VRM look is shown, like vendor/live2d. The app itself has no build step and no runtime npm dependency:
// this script installs the pinned versions into a temporary folder, bundles them with esbuild and copies
// the result in. Run it only to update the versions below, then commit the output.
//
//   node scripts/build-vrm-vendor.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERSIONS = { three: '0.187.0', '@pixiv/three-vrm': '3.5.5', '@pixiv/three-vrm-animation': '3.5.5', esbuild: '0.28.2' };
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'vrm');

const ENTRY = `
import { WebGLRenderer, Scene, PerspectiveCamera, DirectionalLight, AmbientLight, Object3D, Vector3, Box3, Quaternion, Euler, MathUtils, SRGBColorSpace, Clock, AnimationMixer, LoopRepeat } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMExpressionPresetName, VRMHumanBoneName } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
export const THREE = { WebGLRenderer, Scene, PerspectiveCamera, DirectionalLight, AmbientLight, Object3D, Vector3, Box3, Quaternion, Euler, MathUtils, SRGBColorSpace, Clock, AnimationMixer, LoopRepeat };
export { GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMExpressionPresetName, VRMHumanBoneName, VRMAnimationLoaderPlugin, createVRMAnimationClip };
export const versions = ${JSON.stringify({ three: VERSIONS.three, 'three-vrm': VERSIONS['@pixiv/three-vrm'], 'three-vrm-animation': VERSIONS['@pixiv/three-vrm-animation'] })};
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-vendor-'));
try {
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'vrm-vendor', private: true }));
  sh('npm', ['install', '--no-audit', '--no-fund', ...Object.entries(VERSIONS).map(([n, v]) => `${n}@${v}`)]);
  fs.writeFileSync(path.join(tmp, 'entry.js'), ENTRY);
  fs.mkdirSync(OUT, { recursive: true });
  const banner = `/* three.js r${VERSIONS.three.split('.')[1]} (MIT, three.js authors) + @pixiv/three-vrm ${VERSIONS['@pixiv/three-vrm']} + @pixiv/three-vrm-animation ${VERSIONS['@pixiv/three-vrm-animation']} (MIT, pixiv Inc.) — built by scripts/build-vrm-vendor.js; licenses in this folder */`;
  require(path.join(tmp, 'node_modules', 'esbuild')).buildSync({
    absWorkingDir: tmp, entryPoints: ['entry.js'], bundle: true, minify: true, format: 'iife', globalName: 'PetVrmRuntime',
    target: 'chrome120', banner: { js: banner }, legalComments: 'none', outfile: path.join(OUT, 'three-vrm.min.js'),
  });
  fs.copyFileSync(path.join(tmp, 'node_modules', 'three', 'LICENSE'), path.join(OUT, 'three.LICENSE'));
  fs.copyFileSync(path.join(tmp, 'node_modules', '@pixiv', 'three-vrm', 'LICENSE'), path.join(OUT, 'three-vrm.LICENSE'));
  fs.copyFileSync(path.join(tmp, 'node_modules', '@pixiv', 'three-vrm-animation', 'LICENSE'), path.join(OUT, 'three-vrm-animation.LICENSE'));
  console.log(`wrote ${OUT}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
