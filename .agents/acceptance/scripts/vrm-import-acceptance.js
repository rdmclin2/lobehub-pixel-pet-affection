// VRM 角色包导入核心 (T-2647) on the real app: a synthetic VRM 1.0 (the whale model's license meta, no
// third-party mesh) and a synthetic 0.x model are imported through the real `import-vrm` IPC, the pack lands in
// <userData>/packs only, the license read from the model reaches 外观, and bad files are refused.
// usage: xvfb-run -a node .agents/acceptance/scripts/vrm-import-acceptance.js <repo or worktree> <out dir>
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { execSync } = require('node:child_process');
const [ROOT, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const note = (s) => { log.push(s); console.log(s); };

function glb(json) {
  let j = Buffer.from(JSON.stringify(json), 'utf8');
  if (j.length % 4) j = Buffer.concat([j, Buffer.alloc(4 - (j.length % 4), 0x20)]);
  const out = Buffer.alloc(20 + j.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(j.length, 12); out.writeUInt32LE(0x4e4f534a, 16); j.copy(out, 20);
  return out;
}
const PRESETS = Object.fromEntries(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral'].map((n) => [n, {}]));
const WHALE_META = { name: '蓝色小肥鱼Deepseek', version: '1.0.0', authors: ['木子惡魔'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, commercialUsage: 'personalNonProfit', allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false, creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' };

(async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-src-'));
  const whale = path.join(src, 'whale-meta-only.vrm');
  fs.writeFileSync(whale, glb({ asset: { version: '2.0' }, extensions: { VRMC_vrm: { specVersion: '1.0', meta: WHALE_META, humanoid: { humanBones: {} }, expressions: { preset: PRESETS } }, VRMC_springBone: { specVersion: '1.0' } } }));
  const old = path.join(src, 'old-0x.vrm');
  fs.writeFileSync(old, glb({ asset: { version: '2.0' }, extensions: { VRM: { specVersion: '0.0', meta: { title: 'Old Fish 0x', author: 'Maker0', licenseName: 'CC_BY_NC_ND', sexualUssageName: 'Disallow', commercialUssageName: 'Allow', allowedUserName: 'Everyone' }, blendShapeMaster: { blendShapeGroups: [{ name: 'Joy', presetName: 'joy' }, { name: 'A', presetName: 'a' }] } } } }));
  const fake = path.join(src, 'not-a-model.vrm');
  fs.writeFileSync(fake, 'PK this is a zip, not glTF');

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-data-'));
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-lh-'));
  fs.writeFileSync(path.join(fakeLh, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  note(`revision ${execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()} (worktree ${ROOT})`);
  note(`userData = ${data}`);
  const app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: data, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fakeLh } });
  const page = await app.firstWindow();
  page.on('dialog', (d) => d.accept());
  let ok = true;
  const check = (cond, msg) => { note(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) ok = false; };
  try {
    await page.waitForSelector('.char-card', { timeout: 20000 });
    await page.click('.char-card[data-species="dafeiyu"]');
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });

    // 1) import the VRM 1.0 model through the real IPC (the file dialog answered by debug-next-open)
    await page.evaluate((p) => window.pet.debugNextOpen(p), whale);
    const r1 = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
    fs.writeFileSync(path.join(OUT, 'import-vrm1-result.json'), JSON.stringify(r1, null, 2));
    check(r1.ok === true, `import-vrm (VRM 1.0) ok → pack ${r1.pack && r1.pack.id}, model ${r1.model}`);
    const dest = path.join(data, 'packs', r1.pack.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'pack.json'), 'utf8'));
    fs.writeFileSync(path.join(OUT, 'generated-pack.json'), JSON.stringify(manifest, null, 2));
    check(manifest.kind === 'vrm' && manifest.vrm.outfits.daily === 'models/whale-meta-only.vrm', `generated pack.json: kind=${manifest.kind}, vrm.outfits.daily=${manifest.vrm.outfits.daily}, ${Object.keys(manifest.vrm.outfits).length} all-ages outfits, adult=${manifest.adult === true}`);
    check(fs.readFileSync(path.join(dest, 'models', 'whale-meta-only.vrm')).equals(fs.readFileSync(whale)), 'model copied byte-for-byte into userData/packs/<id>/models (not modified)');
    check(r1.license.redistributable === false && r1.license.adultOk === false && r1.license.author === '木子惡魔', `license read from the model: ${r1.license.summary}`);
    for (const x of r1.license.restrictions) note(`      restriction ${x.id} [${x.enforced}]: ${x.text}`);
    const vrmInRepo = execSync('git ls-files "*.vrm" "**/*.vrm"; find src -iname "*.vrm"', { cwd: ROOT }).toString().trim();
    check(vrmInRepo === '', 'nothing written into the repository: git ls-files / find src show no .vrm');

    // 2) VRM 0.x
    await page.evaluate((p) => window.pet.debugNextOpen(p), old);
    const r2 = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
    fs.writeFileSync(path.join(OUT, 'import-vrm0-result.json'), JSON.stringify(r2, null, 2));
    check(r2.ok === true && r2.meta.vrmVersion === '0.x' && r2.meta.modification === 'prohibited' && r2.meta.commercialUsage === 'personalNonProfit', `import-vrm (VRM 0.x) ok → ${r2.pack && r2.pack.id}: ${r2.license && r2.license.summary}`);

    // 3) a fake .vrm is refused and nothing is written
    const before = fs.readdirSync(path.join(data, 'packs')).sort().join(',');
    await page.evaluate((p) => window.pet.debugNextOpen(p), fake);
    const r3 = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
    fs.writeFileSync(path.join(OUT, 'import-fake-result.json'), JSON.stringify(r3, null, 2));
    check(r3.ok === false && /glTF/.test(r3.errors[0]) && fs.readdirSync(path.join(data, 'packs')).sort().join(',') === before, `fake .vrm refused: ${r3.errors && r3.errors[0]}`);

    // 4) ⋯ → 角色列表 → 大肥鱼 → 外观 lists the imported packs with the model's author and license (from the VRM meta)
    await page.mouse.move(110, 150);
    await page.waitForSelector('body.hover', { timeout: 5000 });
    await page.click('[data-act="menu"]');
    await page.click('[data-menu="characters"]');
    await page.waitForSelector('.char-list .char-opt');
    await page.click('.char-list .char-opt[data-species="dafeiyu"] .char-open');
    await page.waitForSelector('.pack-list .pack-opt');
    const row = page.locator(`.pack-opt[data-pack="${r1.pack.id}"]`);
    await row.scrollIntoViewIfNeeded();
    const rowText = await row.textContent();
    const row2 = await page.locator(`.pack-opt[data-pack="${r2.pack.id}"]`).textContent();
    check(/木子惡魔/.test(rowText) && /不可再分发/.test(rowText) && /需署名/.test(rowText), `外观 lists the imported VRM with the model's author and license: "${rowText.trim()}"`);
    check(/Maker0/.test(row2) && /CC_BY_NC_ND/.test(row2), `外观 lists the 0.x model: "${row2.trim()}"`);
    await page.screenshot({ path: path.join(OUT, 'appearance-list-vrm.png') });
  } catch (e) {
    ok = false;
    note(`ERROR ${e.stack || e}`);
    await page.screenshot({ path: path.join(OUT, 'error.png') }).catch(() => {});
  } finally {
    await app.close();
    note(ok ? 'RESULT: all checks passed' : 'RESULT: failures above');
    fs.writeFileSync(path.join(OUT, 'vrm-import-log.txt'), `${log.join('\n')}\n`);
    process.exit(ok ? 0 : 1);
  }
})();
