'use strict';
// lobe-design initialisation + the admin design system: the init artifacts are present and pass the skill's own
// checks, the build chain is wired into start / dist, the bundle stays offline, and the exported tokens match
// @lobehub/ui's theme.css.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SKILL = '.agents/skills/lobe-design';
const skillVersion = read(`${SKILL}/SKILL.md`).match(/^version:\s*(\S+)/m)[1];
const hasUi = fs.existsSync(path.join(ROOT, 'node_modules/@lobehub/ui/es/theme.css'));
const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8' });

test('lobe-design skill is installed in the repo and wired into AGENTS.md (05-init)', () => {
  for (const f of ['SKILL.md', 'stages/05-init.md', 'scripts/bootstrap.mjs', 'scripts/project-scan.mjs', 'scripts/lint-lobe.mjs']) {
    assert.ok(fs.existsSync(path.join(ROOT, SKILL, f)), `${SKILL}/${f}`);
  }
  const agents = read('AGENTS.md');
  assert.match(agents, /<!-- lobe-design:begin[\s\S]*<!-- lobe-design:end -->/);
  assert.match(agents, new RegExp(`skill version ${skillVersion.replace(/\./g, '\\.')}`));
  assert.ok(agents.startsWith('# Notes for coding agents'), 'content outside the managed block is untouched');
  const r = run(`${SKILL}/scripts/bootstrap.mjs`, ['--check', '--root', '.']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('project layer (.agents/ux) is complete and current', () => {
  const product = read('.agents/ux/product.md');
  assert.match(product, new RegExp(`<!-- lobe-design-init: version=${skillVersion.replace(/\./g, '\\.')} fingerprint=\\w+ -->`));
  assert.match(product, /^平台：desktop$/m);
  assert.match(product, /^copy-profile: consumer$/m);
  assert.match(product, /^lint-allow: .* src\/renderer\/\*\*$/m);
  assert.match(read('.agents/ux/components.md'), /<!-- lobe-design-init: version=/);
  const r = run(`${SKILL}/scripts/project-scan.mjs`, ['--check', '--root', '.']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /过期|WARN/, r.stdout);
});

test('lint-lobe: 0 FAIL in admin/src (no exemptions) and in src/renderer (with the documented lint-allow)', () => {
  for (const dir of ['admin/src', 'src/renderer']) {
    const r = run(`${SKILL}/scripts/lint-lobe.mjs`, [dir]);
    const m = r.stdout.match(/RESULT: (\d+) FAIL/);
    assert.ok(m, r.stdout + r.stderr);
    assert.equal(Number(m[1]), 0, `${dir}\n${r.stdout}`);
  }
});

test('admin build is wired into start and every dist target, and lands inside build.files', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:admin'], 'vite build --config admin/vite.config.mjs');
  for (const s of ['start', 'start:no-sandbox', 'dist:mac', 'dist:win', 'dist:linux']) {
    assert.ok(pkg.scripts[s], s);
    // dist:win also builds / checks the Windows desktop helper first (docs/wallpaper-mode.md §7.5)
    const extra = s === 'dist:win' ? ' && node scripts/build-win-helper.js --ensure' : '';
    assert.equal(pkg.scripts[`pre${s}`], `npm run build:admin${extra}`, `pre${s}`);
  }
  assert.ok(pkg.build.files.includes('src/**/*'));
  assert.ok(!pkg.build.files.some((f) => /admin-ui/.test(f)), 'src/admin-ui is not excluded from the package');
  assert.match(read('admin/vite.config.mjs'), /outDir: fileURLToPath\(new URL\('\.\.\/src\/admin-ui'/);
  assert.match(read('admin/vite.config.mjs'), /base: '\.\/'/);
  assert.match(read('.gitignore'), /^src\/admin-ui\/$/m);
  // React / lobe-ui are bundled at build time: nothing new in the runtime dependencies
  assert.deepEqual(Object.keys(pkg.dependencies), ['electron-updater']);
  for (const d of ['@lobehub/ui', 'react', 'react-dom', 'vite']) assert.ok(pkg.devDependencies[d], d);
});

test('admin window stays offline: strict CSP and no remote web fonts', () => {
  const html = read('admin/index.html');
  const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'( 'wasm-unsafe-eval')?;/);
  assert.doesNotMatch(csp, /'unsafe-eval'/, 'no JS eval (WebAssembly only, for the chat code highlighter)');
  assert.doesNotMatch(csp, /https?:/);
  assert.match(read('admin/src/design/DesignProvider.tsx'), /enableCustomFonts=\{false\}/);
  assert.doesNotMatch(read('admin/src/design/DesignProvider.tsx'), /<FontLoader/);
});

test('design tokens cover colours (light + dark), type, spacing, radius, shadow and motion', () => {
  const tokens = JSON.parse(read('src/renderer/design/tokens.json'));
  assert.equal(tokens.source.package, '@lobehub/ui');
  assert.equal(tokens.skill.version, skillVersion);
  const groups = new Set(tokens.tokens.map((t) => t.group));
  for (const g of ['color', 'typography', 'spacing', 'radius', 'shadow', 'motion']) assert.ok(groups.has(g), g);
  const byKey = Object.fromEntries(tokens.tokens.map((t) => [t.key, t]));
  assert.equal(byKey.colorBgLayout.light, '#f8f8f8');
  assert.equal(byKey.colorBgLayout.dark, '#000000');
  assert.equal(byKey.borderRadiusLG.light, '12px');
  assert.ok(Object.values(tokens.space).every((v) => v === 2 || v % 4 === 0), 'space scale on the 4 px grid');
  const css = read('src/renderer/design/lobe-tokens.css');
  assert.match(css, /\[data-theme='dark'\] \{[\s\S]*--lobe-color-bg-layout: #000000;/);
  assert.match(css, /--pet-space-lg: 16px;/);
});

test('exported tokens are in sync with @lobehub/ui theme.css and tokens.ts', { skip: !hasUi && 'node_modules/@lobehub/ui not installed' }, () => {
  const r = run('scripts/build-design-tokens.mjs', ['--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
