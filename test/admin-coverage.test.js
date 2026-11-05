'use strict';
// 配置后台覆盖度 (docs/admin-console-design.md §12, src/core/admin-coverage.js): every user-configurable
// settings.json key, pet-window channel, menu item and runtime behaviour has its place in the settings window;
// the audit catches a gap; and the controls added for it (自动检查更新, 服饰, 设定, 形象类型, 找回桌宠, 数据目录) work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const coverage = require('../src/core/admin-coverage');
const settingsLib = require('../src/core/settings');
const schema = require('../src/core/settings-schema');
const { buildRoster, packKinds } = require('../src/core/roster');
const { loadPacks } = require('../src/core/packs');
const { createAdminSettings } = require('../src/main/admin-settings');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const inputs = () => coverage.collect(ROOT);

test('coverage audit on this tree: no gaps — every settings.json leaf, pet channel, menu item and runtime behaviour is covered', () => {
  const i = inputs();
  const r = coverage.audit(i);
  assert.deepEqual(r.problems, []);
  // the lists really come from the code (not empty, not a stub)
  assert.equal(r.settings.length, schema.settingsLeaves().length);
  assert.ok(r.settings.length >= 54, `${r.settings.length} leaves`);
  assert.ok(i.petChannels.length >= 70, `${i.petChannels.length} pet channels`);
  assert.ok(i.adminChannels.length >= 35, `${i.adminChannels.length} admin channels`);
  assert.deepEqual(i.trayItems, ['打开设置…', '显示桌宠', '像素小院', '重置姿势', '检查更新', '退出']);
  // the pet window has no ⋯ menu any more (T-2718: only ⚙); each former item and toolbar button has its place
  assert.deepEqual(i.menuItems, []);
  const former = r.menu.filter((m) => /^(menu|toolbar):/.test(m.id));
  assert.ok(former.length >= 17, `${former.length} former menu / toolbar items`);
  for (const id of ['menu:home', 'menu:adult', 'menu:history', 'menu:quit', 'toolbar:topics', 'toolbar:wardrobe']) assert.equal(former.find((m) => m.id === id).status, 'ok', id);
  // every user setting is in the console; internal ones are exactly the bookkeeping flags
  assert.deepEqual(r.settings.filter((s) => s.status === 'internal').map((s) => s.key).sort(), Object.keys(coverage.INTERNAL_SETTINGS).sort());
  assert.ok(r.settings.filter((s) => s.status === 'ok').every((s) => ['即时生效', '重启后生效'].includes(s.apply)));
  assert.equal(r.settings.find((s) => s.key === 'system.hardwareAcceleration').apply, '重启后生效');
  assert.equal(r.settings.find((s) => s.key === 'update.autoCheck').apply, '即时生效');
  // the runtime behaviours the task names are all there and controlled
  const ids = r.runtime.map((x) => x.id);
  for (const id of ['roam', 'proactive', 'affection', 'visitors', 'tts', 'asr', 'api', 'update', 'safety', 'data', 'character']) assert.ok(ids.includes(id), id);
  assert.ok(r.runtime.every((x) => x.status === 'ok'));
});

test('coverage audit catches a gap: a setting without a field, an unclassified channel / menu item, a bridge nobody calls', () => {
  const i = inputs();
  const fields = i.fields.filter((f) => f.key !== 'prefs.roam');
  const r1 = coverage.audit({ ...i, fields });
  assert.ok(r1.problems.some((p) => p.includes('`prefs.roam` 在 settings-schema.js 里没有字段')), r1.problems.join('\n'));
  assert.ok(r1.problems.some((p) => p.includes('「走动」')), 'the runtime behaviour loses its control too');
  const r2 = coverage.audit({ ...i, leaves: [...i.leaves, 'prefs.newThing'] });
  assert.ok(r2.problems.some((p) => p.includes('`prefs.newThing`')));
  const r3 = coverage.audit({ ...i, petChannels: [...i.petChannels, 'set-something-new'] });
  assert.ok(r3.problems.some((p) => p.includes('`set-something-new`')));
  const r4 = coverage.audit({ ...i, menuItems: [...i.menuItems, 'mute'] });
  assert.ok(r4.problems.some((p) => p.includes('`menu:mute`')));
  const r5 = coverage.audit({ ...i, consoleCalls: i.consoleCalls.filter((c) => c !== 'equipOutfit') });
  assert.ok(r5.problems.some((p) => p.includes('window.petAdmin.equipOutfit 没有任何页面调用')));
  // a pet-only control that moves to the settings window must keep its admin channel
  const r6 = coverage.audit({ ...i, adminChannels: i.adminChannels.filter((c) => c !== 'equip-outfit') });
  assert.ok(r6.problems.some((p) => p.includes('`equip-outfit`')));
  // an internal flag must say why
  const r7 = coverage.audit({ ...i, fields: i.fields.map((f) => (f.key === 'prefs.memes' ? { ...f, internal: true } : f)) });
  assert.ok(r7.problems.some((p) => p.includes('`prefs.memes` 被标成 internal')));
});

test('docs §12 覆盖矩阵 is generated from the audit and up to date; the check script passes', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'admin-console-design.md'), 'utf8');
  const matrix = coverage.renderMatrix(coverage.audit(inputs()));
  assert.ok(doc.includes(matrix), 'run node scripts/check-admin-console-doc.js --write');
  for (const k of schema.settingsLeaves()) assert.ok(matrix.includes(`\`${k}\``), k);
  assert.match(matrix, /缺失：无/);
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-admin-console-doc.js')], { encoding: 'utf8' });
  assert.match(out, /PASS: .*coverage matrix has no gaps/);
  assert.match(out, /§12 in the doc: up to date/);
});

// ---- the controls added for the gaps ----------------------------------------------------------------------

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admincov-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const data = path.join(dir, 'data');
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const { packs } = require('../src/core/catalog').repoPacks();
  const svc = new PetService({ lh, store: new Store(data), settingsStore: new settingsLib.SettingsStore(data), now: () => new Date('2026-01-05T14:00:00').getTime(), rnd: () => 0.5, packs });
  svc.on('error', () => {});
  const admin = createAdminSettings({ service: svc });
  const file = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  return { svc, admin, file, data };
}

test('自动检查更新 (update.autoCheck): default on, saved through admin-set, survives normalisation, applies at once', async () => {
  assert.deepEqual(settingsLib.normalizeSettings(null).update, { autoCheck: true });
  assert.deepEqual(settingsLib.normalizeSettings({ update: { autoCheck: 'no' } }).update, { autoCheck: true });
  const f = schema.field('update.autoCheck');
  assert.equal(f.page, 'update');
  assert.equal(f.type, 'switch');
  assert.equal(f.live, true);
  assert.equal(f.restart, false);
  assert.deepEqual(schema.patchFor('update.autoCheck', false), { setter: 'setSection', section: 'update', patch: { autoCheck: false } });
  const { admin, file, svc } = setup();
  const r = await admin.set('update.autoCheck', false);
  assert.equal(r.ok, true);
  assert.equal(r.value, false);
  assert.equal(r.restart, false);
  assert.equal(file().update.autoCheck, false);
  assert.equal(svc.settings.update.autoCheck, false); // the updater's autoCheck() reads this at every scheduled check
  assert.equal((await admin.set('update.autoCheck', 'off')).ok, false);
  const back = await admin.reset(['update.autoCheck']);
  assert.equal(back.ok, true);
  assert.equal(file().update.autoCheck, true);
  // the updater's scheduled check asks autoCheck(); 检查更新 (checkNow) does not
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'updater.js'), 'utf8');
  assert.match(src, /const check = \(\) => \(now \|\| this\.autoCheck\(\) \? this\.checkNow\(\) : this\.state\);/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8'), /autoCheck: \(\) => !!\(service && service\.settings\.update && service\.settings\.update\.autoCheck\)/);
});

test('roster rows carry her 设定 (persona), her own kind of look, and the current character\'s outfits', async () => {
  const { svc } = setup();
  await svc.hatch({ speciesId: 'dafeiyu', name: '小鱼' });
  const rows = buildRoster(svc.view(), svc.settingsView());
  const fish = rows.find((r) => r.id === 'dafeiyu-pixel');
  assert.ok(fish.personality.length > 20, 'her persona from the character file');
  assert.equal(rows.find((r) => r.id === 'dafeiyu-live2d').personality, fish.personality, 'inherited by each of her looks');
  // T-2764: every look is a character: each row has exactly her own kind
  assert.deepEqual(fish.packKinds, [{ kind: 'sprites', label: '像素', builtin: 1, user: 0 }]);
  const l2d = rows.find((r) => r.id === 'dafeiyu-live2d');
  assert.deepEqual(l2d.packKinds, [{ kind: 'live2d', label: 'Live2D', builtin: 1, user: 0 }]);
  assert.equal(rows.find((r) => r.id === 'dafeiyu-live').kind, 'rig');
  assert.equal(l2d.outfits, null, 'not the current character: no outfits known');
  // outfits: only the current character's, each with lock state and a preview
  assert.ok(Array.isArray(fish.outfits) && fish.outfits.length >= 1);
  assert.equal(fish.outfits.filter((o) => o.equipped).length, 1);
  assert.ok(fish.outfits.some((o) => o.locked && /解锁/.test(o.condition)), 'a locked outfit says how to unlock it');
  assert.equal(rows.find((r) => r.id === 'claude-pixel').outfits, null);
  // unlock + equip (the console's 服饰 → 穿上 calls equip-outfit = PetService.equipOutfit)
  svc.unlockAll('dafeiyu');
  const target = buildRoster(svc.view(), svc.settingsView()).find((r) => r.id === 'dafeiyu-pixel').outfits.find((o) => !o.equipped && !o.locked);
  assert.ok(target, 'an unlocked outfit to put on');
  const r = svc.equipOutfit(target.id);
  assert.equal(r.ok, true);
  assert.equal(buildRoster(r.view, svc.settingsView()).find((x) => x.id === 'dafeiyu-pixel').outfits.find((o) => o.equipped).id, target.id);
  // packKinds counts imported packs apart
  assert.deepEqual(packKinds([{ kind: 'vrm', source: 'user' }, { kind: 'vrm', source: 'builtin' }, { kind: 'pictures', source: 'user' }]), [{ kind: 'vrm', label: 'VRM', builtin: 1, user: 1 }, { kind: 'pictures', label: '图片', builtin: 0, user: 1 }]);
});

test('settings window bridge: 服饰, 找回桌宠 and 数据目录 are whitelisted and answer the settings window only', () => {
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'main', 'admin-preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  assert.match(pre, /equipOutfit: \(id, species\) => ipcRenderer\.invoke\('equip-outfit', \{ id, species \}\)/);
  assert.match(main, /ipcMain\.handle\('equip-outfit', \(_e, \{ id, species \}\) => service\.equipOutfit\(String\(id \|\| ''\), whose\(species\)\)\)/);
  assert.match(pre, /placePet: \(\) => ipcRenderer\.invoke\('admin-place-pet'\)/);
  assert.match(pre, /openDataFolder: \(\) => ipcRenderer\.invoke\('open-data-folder'\)/);
  assert.match(main, /ipcMain\.handle\('admin-place-pet', adminOnly\(/);
  assert.match(main, /ipcMain\.handle\('open-data-folder', adminOnly\(/);
  assert.match(main, /dataDir: app\.getPath\('userData'\)/);
});

// T-2784: her page lists the 衣柜 of any character met before, as cards — not only the current one's — and
// 穿上 there saves into that character's own wardrobe without touching who is with you now.
test('衣柜 cards for every met character: outfitsOf + equipOutfit(id, character) keep each character\'s own wardrobe', async () => {
  const { svc } = setup();
  await svc.hatch({ speciesId: 'dafeiyu', name: '小鱼' });
  svc.unlockAll('dafeiyu');
  const rows = buildRoster(svc.view(), svc.settingsView(), { outfitsOf: (id) => svc.outfitsOf(id) });
  const pixel = rows.find((r) => r.id === 'dafeiyu-pixel');
  const l2d = rows.find((r) => r.id === 'dafeiyu-live2d');
  assert.equal(pixel.current, true);
  assert.equal(l2d.current, false);
  // the other look of the same base is met (shared hearts): her own wardrobe is listed, from her own pack
  assert.ok(Array.isArray(l2d.outfits) && l2d.outfits.length >= 1, 'Live2D 大肥鱼 has her own outfit cards');
  assert.ok(l2d.outfits.length < pixel.outfits.length, 'her Live2D pack has fewer outfits than the pixel one');
  assert.equal(l2d.outfits.filter((o) => o.equipped).length, 1);
  assert.ok(pixel.outfits.every((o) => 'rating' in o && 'isNew' in o && 'preview' in o), 'each card: rating, 新, preview');
  assert.ok(pixel.outfits.filter((o) => !o.locked).every((o) => o.preview && o.preview.type === 'sprite' && o.preview.frame), 'pixel cards show a sheet cell');
  // a character of a base not met yet has no wardrobe to show
  assert.equal(rows.find((r) => r.id === 'claude-pixel').outfits, null);
  assert.equal(svc.outfitsOf('claude-pixel'), null);
  // 穿上 on another character of hers: saved in her wardrobe, the one with you keeps hers
  assert.equal((await svc.switchCharacter('dafeiyu-live2d')).ok, true);
  const wornBefore = svc.view().pet.equippedOutfit;
  const other = svc.outfitsOf('dafeiyu-pixel').find((o) => !o.locked && !o.equipped);
  const r = svc.equipOutfit(other.id, 'dafeiyu-pixel');
  assert.equal(r.ok, true);
  assert.equal(svc.view().pet.characterId, 'dafeiyu-live2d', 'still the same character with you');
  assert.equal(svc.view().pet.equippedOutfit, wornBefore, 'her outfit untouched');
  assert.equal(svc.outfitsOf('dafeiyu-pixel').find((o) => o.equipped).id, other.id, 'the pixel 大肥鱼 wears it next time');
  const back = buildRoster(r.view, svc.settingsView(), { outfitsOf: (id) => svc.outfitsOf(id) }).find((x) => x.id === 'dafeiyu-pixel');
  assert.equal(back.outfits.find((o) => o.equipped).id, other.id, 'and her card says 正在穿');
  // her Live2D outfit cannot go on her pixel self's wardrobe and the other way round (her own pack's outfits only)
  assert.equal(svc.equipOutfit(other.id, 'dafeiyu-live2d').ok, false);
  assert.equal(svc.equipOutfit('daily', 'claude-pixel').reason, 'not-met');
  assert.equal(svc.equipOutfit('daily', 'nobody').reason, 'unknown');
});
