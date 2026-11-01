'use strict';
// VRM 角色包 (kind "vrm"): meta parsing (1.0 and 0.x), license restrictions, pack validation, the app's own
// 18+ / affection / outfit rules, the importer, and the packaging guard. Every model here is a minimal GLB
// built in the test; no third-party model is committed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const V = require('../src/core/vrm');
const P = require('../src/core/packs');
const I = require('../src/core/vrm-import');
const o = require('../src/core/outfits');
const st = require('../src/core/pet-state');

const ROOT = path.join(__dirname, '..');
const BUILTIN = path.join(ROOT, 'src', 'renderer', 'packs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

// A glTF binary: header, JSON chunk (space-padded to 4 bytes), optional BIN chunk.
function glb(json, bin = Buffer.alloc(8)) {
  let j = Buffer.from(JSON.stringify(json), 'utf8');
  if (j.length % 4) j = Buffer.concat([j, Buffer.alloc(4 - (j.length % 4), 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const out = Buffer.alloc(12 + 8 + j.length + 8 + b.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(j.length, 12); out.writeUInt32LE(0x4e4f534a, 16); j.copy(out, 20);
  out.writeUInt32LE(b.length, 20 + j.length); out.writeUInt32LE(0x004e4942, 24 + j.length); b.copy(out, 28 + j.length);
  return out;
}

// The license of 木子惡魔《蓝色小肥鱼Deepseek》 (VRM 1.0, as its release states): personal non-profit, no
// modification, no redistribution, credit required. Only the meta is reproduced here, never the model.
const WHALE_META = {
  name: '蓝色小肥鱼Deepseek', version: '1.0.0', authors: ['木子惡魔'], copyrightInformation: '© 木子惡魔',
  contactInformation: 'https://github.com/sunfish1728', references: ['https://github.com/sunfish1728/deepcoin-avatars'],
  licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', allowExcessivelyViolentUsage: false,
  allowExcessivelySexualUsage: false, commercialUsage: 'personalNonProfit', allowPoliticalOrReligiousUsage: false,
  allowAntisocialOrHateUsage: false, creditNotation: 'required', allowRedistribution: false, modification: 'prohibited',
};
const PRESETS = Object.fromEntries(V.VRM_PRESET_EXPRESSIONS.map((n) => [n, {}]));
const vrm1 = (meta = WHALE_META, extra = {}) => glb({ asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm', 'VRMC_springBone'], extensions: { VRMC_vrm: { specVersion: '1.0', meta, humanoid: { humanBones: {} }, expressions: { preset: PRESETS, custom: { wink_fish: {} } } }, VRMC_springBone: { specVersion: '1.0', springs: [] } }, ...extra });
const vrm0 = (meta) => glb({ asset: { version: '2.0' }, extensions: { VRM: { specVersion: '0.0', meta, blendShapeMaster: { blendShapeGroups: [{ name: 'Joy', presetName: 'joy' }, { name: 'A', presetName: 'a' }, { name: 'Blink_L', presetName: 'blink_l' }, { name: 'Tehe', presetName: 'unknown' }] }, secondaryAnimation: { boneGroups: [{ bones: [1] }] } } } });
const FREE_META = { ...WHALE_META, name: 'Free Fish', authors: ['Someone'], allowExcessivelySexualUsage: true, allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'unnecessary', commercialUsage: 'corporation', avatarPermission: 'everyone' };

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function writeVrmPack(root, manifest, files = {}) {
  const dir = path.join(root, manifest.id || 'x');
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, buf] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), buf); }
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest));
  return dir;
}
const vrmPack = (over = {}) => ({ schema: 2, id: 'my-vrm', name: 'Mine', species: 'dafeiyu', kind: 'vrm', vrm: { outfits: { daily: 'model.vrm' } }, ...over });

test('VRM 1.0 meta: every VRMC_vrm.meta field is read; missing ones take the strict spec defaults', () => {
  const info = V.inspectVrm(vrm1());
  assert.equal(info.ok, true, JSON.stringify(info.errors));
  assert.deepEqual(info.meta, {
    vrmVersion: '1.0', specVersion: '1.0', name: '蓝色小肥鱼Deepseek', version: '1.0.0', authors: ['木子惡魔'],
    copyrightInformation: '© 木子惡魔', contactInformation: 'https://github.com/sunfish1728', references: ['https://github.com/sunfish1728/deepcoin-avatars'],
    thirdPartyLicenses: '', licenseName: '', licenseUrl: 'https://vrm.dev/licenses/1.0/', otherLicenseUrl: '',
    avatarPermission: 'onlyAuthor', allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, commercialUsage: 'personalNonProfit',
    allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false, creditNotation: 'required', allowRedistribution: false, modification: 'prohibited',
  });
  assert.equal(info.expressions.length, 19, '18 presets + one custom');
  assert.ok(['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'happy', 'wink_fish'].every((n) => info.expressions.includes(n)));
  assert.equal(info.springBone, true);
  // an empty meta is the strictest reading, not a permissive one
  const bare = V.inspectVrm(vrm1({ name: 'x', authors: ['a'], licenseUrl: 'u' })).meta;
  assert.deepEqual([bare.allowRedistribution, bare.modification, bare.creditNotation, bare.commercialUsage, bare.allowExcessivelySexualUsage, bare.avatarPermission], [false, 'prohibited', 'required', 'personalNonProfit', false, 'onlyAuthor']);
  // unknown enum values do not loosen it either
  assert.equal(V.inspectVrm(vrm1({ ...FREE_META, modification: 'whatever', allowRedistribution: 'yes' })).meta.modification, 'prohibited');
  assert.equal(V.inspectVrm(vrm1({ ...FREE_META, allowRedistribution: 'yes' })).meta.allowRedistribution, false);
});

test('VRM 0.x meta: extensions.VRM.meta maps onto the same fields; licenseName decides redistribution / modification / credit', () => {
  const m = V.inspectVrm(vrm0({ title: 'Old Fish', version: '0.9', author: 'Maker', contactInformation: 'mail', reference: 'ref', allowedUserName: 'Everyone', violentUssageName: 'Disallow', sexualUssageName: 'Allow', commercialUssageName: 'Allow', licenseName: 'CC_BY_NC_ND', otherPermissionUrl: 'perm', otherLicenseUrl: '' }));
  assert.equal(m.ok, true);
  assert.deepEqual({ ...m.meta }, {
    vrmVersion: '0.x', specVersion: '0.0', name: 'Old Fish', version: '0.9', authors: ['Maker'], copyrightInformation: '', contactInformation: 'mail', references: ['ref'],
    thirdPartyLicenses: '', licenseName: 'CC_BY_NC_ND', licenseUrl: 'perm', otherLicenseUrl: '', avatarPermission: 'everyone',
    allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: true, commercialUsage: 'personalNonProfit', // NC wins over commercial Allow
    allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false, creditNotation: 'required', allowRedistribution: true, modification: 'prohibited',
  });
  assert.deepEqual(m.expressions, ['happy', 'aa', 'blinkLeft', 'Tehe'], '0.x presets in their 1.0 names, custom groups by name');
  assert.equal(m.springBone, true);
  const prohibited = V.inspectVrm(vrm0({ title: 'P', author: 'A', licenseName: 'Redistribution_Prohibited', commercialUssageName: 'Allow' })).meta;
  assert.deepEqual([prohibited.allowRedistribution, prohibited.modification, prohibited.creditNotation, prohibited.commercialUsage, prohibited.avatarPermission, prohibited.allowExcessivelySexualUsage], [false, 'prohibited', 'required', 'personalProfit', 'onlyAuthor', false]);
  const other = V.inspectVrm(vrm0({ title: 'O', licenseName: 'Other', otherLicenseUrl: 'https://x' })).meta;
  assert.deepEqual([other.allowRedistribution, other.modification, other.otherLicenseUrl], [false, 'prohibited', 'https://x'], 'an unknown / Other license is read the strict way');
  const cc0 = V.inspectVrm(vrm0({ title: 'C', licenseName: 'CC0' })).meta;
  assert.deepEqual([cc0.allowRedistribution, cc0.modification, cc0.creditNotation], [true, 'allowModificationRedistribution', 'unnecessary']);
});

test('not a VRM: wrong magic, wrong version, truncated JSON, or a plain glTF without the extension', () => {
  assert.equal(V.isGlb(vrm1()), true);
  assert.match(V.inspectVrm(Buffer.from('PK\u0003\u0004 not a model at all')).errors[0], /no "glTF" magic/);
  const v1 = vrm1(); v1.writeUInt32LE(1, 4);
  assert.match(V.inspectVrm(v1).errors[0], /version 1 is not 2/);
  assert.match(V.inspectVrm(vrm1().subarray(0, 40)).errors[0], /truncated/);
  assert.match(V.inspectVrm(glb({ asset: { version: '2.0' } })).errors[0], /not a VRM model/);
  const dir = tmp('vrm-file-');
  fs.writeFileSync(path.join(dir, 'a.vrm'), vrm1());
  assert.equal(V.inspectVrmFile(path.join(dir, 'a.vrm')).meta.name, '蓝色小肥鱼Deepseek', 'read from disk through the header and JSON chunk only');
  assert.deepEqual(V.inspectVrmFile(path.join(dir, 'missing.vrm')).errors, ['missing']);
});

test('license restrictions: the whale model gets every restriction the app enforces, in zh-CN', () => {
  const lic = V.vrmLicense(V.inspectVrm(vrm1()).meta);
  const byId = Object.fromEntries(lic.restrictions.map((r) => [r.id, r]));
  assert.equal(byId['no-redistribution'].text, '不可再分发：仅限本机使用，不会被打包/分享/导出');
  assert.equal(byId['no-redistribution'].enforced, 'share-blocked');
  assert.equal(byId['no-modification'].text, '禁止修改：应用只做运行时表情/姿态驱动，不改写模型文件');
  assert.equal(byId['credit-required'].text, '需署名：界面会显示作者（木子惡魔）');
  assert.equal(byId['personal-non-profit'].text, '仅限个人非商业');
  assert.equal(byId['no-sexual'].text, '禁止性表现：该模型在 18+ 内容/成人服饰下不可用（由应用强制）');
  assert.equal(byId['no-sexual'].enforced, 'adult-blocked');
  assert.ok(byId['no-violent'] && byId['no-political'] && byId['no-antisocial'] && byId['avatar-permission']);
  assert.deepEqual([lic.redistributable, lic.adultOk, lic.creditRequired, lic.author], [false, false, true, '木子惡魔']);
  assert.equal(lic.summary, 'VRM 1.0 授权：仅限个人非商业使用 / 不可再分发 / 禁止修改 / 需署名');
  const free = V.vrmLicense(V.inspectVrm(vrm1(FREE_META)).meta);
  assert.deepEqual(free.restrictions.map((r) => r.id), ['no-violent', 'no-political', 'no-antisocial'], 'a permissive model keeps only what it still forbids');
  assert.deepEqual([free.redistributable, free.adultOk], [true, true]);
});

test('vrm packs: models per outfit are checked (inside the pack, existing, glTF binary, VRM) and their license goes with the pack', () => {
  const root = tmp('vrm-packs-');
  const dir = writeVrmPack(root, vrmPack({ author: 'pack.json says CC0', license: 'CC0', vrm: { outfits: { daily: 'model.vrm', pajamas: 'pj/model.vrm' }, height: 0.7, expressions: { pat: 'happy', sleep: 'relaxed' } }, outfits: { daily: 'preview.png' } }), { 'model.vrm': vrm1(), 'pj/model.vrm': vrm1(), 'preview.png': PNG });
  const r = P.readPack(dir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p = r.pack;
  assert.equal(p.kind, 'vrm');
  assert.deepEqual(p.outfits, { daily: 'model.vrm', pajamas: 'pj/model.vrm' });
  assert.deepEqual([p.vrm.height, p.vrm.expressions, p.vrm.previews], [0.7, { pat: 'happy', sleep: 'relaxed' }, { daily: 'preview.png' }]);
  assert.equal(p.author, '木子惡魔', 'author comes from the model, not pack.json');
  assert.equal(p.license, 'VRM 1.0 授权：仅限个人非商业使用 / 不可再分发 / 禁止修改 / 需署名', 'so does the license');
  assert.equal(p.vrm.models['model.vrm'].meta.allowRedistribution, false);

  const packs = new Map([[p.id, { ...p, source: 'user' }], ...P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]).packs]);
  const look = P.resolveLook(packs, { packId: p.id, speciesId: 'dafeiyu', outfitId: 'daily' });
  assert.equal(look.kind, 'vrm');
  assert.equal(look.model, 'pack://my-vrm/model.vrm');
  assert.equal(look.url, 'pack://my-vrm/preview.png');
  assert.equal(look.vrm.height, 0.7);
  assert.equal(look.vrm.license.redistributable, false);
  assert.equal(look.vrm.meta.name, '蓝色小肥鱼Deepseek');
  assert.ok(look.vrm.modelExpressions.includes('aa'));
  assert.equal(P.resolveLook(packs, { packId: p.id, speciesId: 'dafeiyu', outfitId: 'pajamas' }).url, null, 'no preview picture for that outfit');
  assert.notEqual(P.resolveLook(packs, { packId: p.id, speciesId: 'dafeiyu', outfitId: 'scarf' }).kind, 'vrm', 'other outfits fall back to her default pack');
  const listed = P.packsFor(packs, 'dafeiyu').find((x) => x.id === p.id);
  assert.equal(listed.vrm.author, '木子惡魔');
  assert.ok(listed.vrm.restrictions.some((x) => x.id === 'no-redistribution'));
  assert.equal(listed.vrm.models[0].meta.contactInformation, 'https://github.com/sunfish1728');
});

test('bad vrm packs are refused: path escape (also by symlink), missing file, not glTF, not VRM, unknown outfit / state / expression', () => {
  const root = tmp('vrm-bad-');
  const outside = path.join(root, 'outside.vrm');
  fs.writeFileSync(outside, vrm1());
  const errs = (manifest, files) => P.readPack(writeVrmPack(root, manifest, files)).errors.join('\n');
  assert.match(errs(vrmPack({ id: 'esc-a', vrm: { outfits: { daily: '../outside.vrm' } } })), /must be a relative path to a \.vrm/);
  assert.match(errs(vrmPack({ id: 'esc-b', vrm: { outfits: { daily: outside } } })), /must be a relative path/);
  const linkDir = writeVrmPack(root, vrmPack({ id: 'esc-c' }));
  fs.symlinkSync(outside, path.join(linkDir, 'model.vrm'));
  assert.match(P.readPack(linkDir).errors.join(), /points outside the pack/);
  assert.match(errs(vrmPack({ id: 'miss' })), /model\.vrm is missing/);
  assert.match(errs(vrmPack({ id: 'nglb' }), { 'model.vrm': PNG }), /no "glTF" magic/);
  assert.match(errs(vrmPack({ id: 'nvrm' }), { 'model.vrm': glb({ asset: { version: '2.0' } }) }), /not a VRM model/);
  assert.match(errs(vrmPack({ id: 'ext', vrm: { outfits: { daily: 'model.glb' } } }), { 'model.glb': vrm1() }), /\.vrm file/);
  assert.match(errs(vrmPack({ id: 'none', vrm: {} })), /vrm\.outfits must map at least one outfit/);
  assert.match(errs(vrmPack({ id: 'unk', vrm: { outfits: { tuxedo: 'model.vrm' } } }), { 'model.vrm': vrm1() }), /unknown outfit/);
  assert.match(errs(vrmPack({ id: 'st', vrm: { outfits: { daily: 'model.vrm' }, expressions: { dance: 'happy' } } }), { 'model.vrm': vrm1() }), /unknown state/);
  assert.match(errs(vrmPack({ id: 'ex', vrm: { outfits: { daily: 'model.vrm' }, expressions: { pat: 'grin' } } }), { 'model.vrm': vrm1() }), /"grin" is not an expression of the model/);
  assert.match(errs(vrmPack({ id: 'ht', vrm: { outfits: { daily: 'model.vrm' }, height: 3 } }), { 'model.vrm': vrm1() }), /vrm\.height/);
});

const ADULT_ON = { ageConfirmed: true, adultContent: true };
const ADULT_OFF = { ageConfirmed: true, adultContent: false };
const NOT_CONFIRMED = { ageConfirmed: false, adultContent: true };
const pet = (affection) => { const p = st.createPet({ speciesId: 'dafeiyu', name: 'E', agentId: 'a', now: Date.now() }); st.setAffectionForTest(p, affection); return p; };

test('app rules win: a VRM pack cannot make adult outfits available — not without 18+, not without affection, not when its license forbids it', () => {
  const root = tmp('vrm-rules-');
  // a model whose license forbids sexual usage cannot dress an adult outfit, nor be an 18+ pack, whatever pack.json says
  const whale = { 'model.vrm': vrm1() };
  assert.match(P.readPack(writeVrmPack(root, vrmPack({ id: 'w-adult', adult: true }), whale)).errors.join(), /cannot be an 18\+ pack/);
  assert.match(P.readPack(writeVrmPack(root, vrmPack({ id: 'w-maid', adult: true, vrm: { outfits: { daily: 'model.vrm', maid: 'model.vrm' } } }), whale)).errors.join(), /does not allow sexual usage/);
  // adult outfits in a pack that is not 18+ are refused too
  assert.match(P.readPack(writeVrmPack(root, vrmPack({ id: 'f-maid', vrm: { outfits: { daily: 'model.vrm', maid: 'model.vrm' } } }), { 'model.vrm': vrm1(FREE_META) })).errors.join(), /needs an 18\+ pack/);

  // fields that try to set the app's rules are ignored: stage, rating, unlock, ageConfirmed …
  const tricky = vrmPack({ id: 'f-adult', adult: true, rating: 'all', unlockAll: true, ageConfirmed: true, adultContent: true, stage: 'stranger', outfitRules: { maid: { stage: 'stranger', rating: 'all' } }, vrm: { outfits: { daily: 'model.vrm', maid: 'maid.vrm', pajamas: 'pajamas.vrm' }, stages: { maid: 'stranger' }, rating: { maid: 'all' } } });
  const r = P.readPack(writeVrmPack(root, tricky, { 'model.vrm': vrm1(FREE_META), 'maid.vrm': vrm1(FREE_META), 'pajamas.vrm': vrm1(FREE_META) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  for (const k of ['rating', 'unlockAll', 'ageConfirmed', 'adultContent', 'stage', 'outfitRules']) assert.equal(k in r.pack, false, k);
  assert.equal('stages' in r.pack.vrm || 'rating' in r.pack.vrm, false);
  const pack = { ...r.pack, source: 'user' };
  const packs = new Map([[pack.id, pack], ...P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]).packs]);
  const look = P.lookContext(pack);
  assert.deepEqual(look, { adult: true, only: true, outfits: ['daily', 'maid', 'pajamas'] });

  // 18+ not confirmed / adult content off: the pack is not even chosen, adult outfits do not exist
  for (const s of [ADULT_OFF, NOT_CONFIRMED]) {
    const adultOk = !!(s.ageConfirmed && s.adultContent);
    assert.notEqual(P.chosenPack(packs, { dafeiyu: pack.id }, 'dafeiyu', adultOk), pack.id);
    assert.equal(P.packsFor(packs, 'dafeiyu', adultOk).some((x) => x.id === pack.id), false);
    const p = pet(100);
    assert.equal(o.listOutfits(p, s, look).some((x) => x.id === 'maid'), false);
    assert.equal(o.equipOutfit(p, s, 'maid', look).ok, false);
  }
  // 18+ on but not enough affection: listed as locked, cannot be worn
  const low = pet(10);
  assert.equal(o.listOutfits(low, ADULT_ON, look).find((x) => x.id === 'maid').locked, true);
  assert.deepEqual([o.equipOutfit(low, ADULT_ON, 'maid', look).ok, o.equipOutfit(low, ADULT_ON, 'maid', look).reason], [false, 'locked']);
  assert.equal(o.equipOutfit(low, ADULT_ON, 'pajamas', look).reason, 'locked', 'all-ages outfits keep their stage too');
  // 18+ on and 暧昧: the app's own unlock lets it on
  const high = pet(70);
  assert.equal(P.chosenPack(packs, { dafeiyu: pack.id }, 'dafeiyu', true), pack.id);
  assert.equal(o.equipOutfit(high, ADULT_ON, 'maid', look).ok, true);
  assert.equal(P.resolveLook(packs, { packId: pack.id, speciesId: 'dafeiyu', outfitId: 'maid' }).kind, 'vrm');
  // then adult content off: back into an all-ages outfit
  assert.equal(o.enforceOutfit(high, ADULT_OFF, P.lookContext(pack)).to, 'daily');

  // defence in depth: a VRM pack object marked 18+ whose license forbids it is never an 18+ look and never dresses an adult outfit
  const forged = { ...pack, id: 'forged', vrm: { ...pack.vrm, license: { ...pack.vrm.license, adultOk: false } } };
  assert.deepEqual(P.lookContext(forged), { adult: false, only: true, outfits: ['daily', 'pajamas'] });
  const fp = new Map([['forged', forged], ...packs]);
  const lk = P.resolveLook(fp, { packId: 'forged', speciesId: 'dafeiyu', outfitId: 'maid' });
  assert.ok(!lk || lk.kind !== 'vrm' || lk.packId !== 'forged');
  assert.equal(o.listOutfits(pet(100), ADULT_ON, P.lookContext(forged)).some((x) => x.id === 'maid'), false);
});

test('sharing: a pack whose VRM may not be redistributed is refused; others may be shared', () => {
  const root = tmp('vrm-share-');
  const whale = P.readPack(writeVrmPack(root, vrmPack({ id: 'whale' }), { 'model.vrm': vrm1() })).pack;
  const free = P.readPack(writeVrmPack(root, vrmPack({ id: 'free' }), { 'model.vrm': vrm1(FREE_META) })).pack;
  assert.deepEqual(P.packShareable(whale), { ok: false, reason: 'no-redistribution', text: '这个 VRM 模型的授权不允许再分发：仅限本机使用，不能打包、分享或导出' });
  assert.deepEqual(P.packShareable(free), { ok: true });
  // one forbidding model in a pack makes the whole pack non-redistributable
  const mixed = P.readPack(writeVrmPack(root, vrmPack({ id: 'mixed', vrm: { outfits: { daily: 'a.vrm', pajamas: 'b.vrm' } } }), { 'a.vrm': vrm1(FREE_META), 'b.vrm': vrm1() })).pack;
  assert.equal(P.packShareable(mixed).ok, false);
  assert.equal(mixed.author, 'Someone、木子惡魔');
});

test('importing a VRM: a .vrm file, a folder or a .zip becomes a user pack in the user folder with a generated pack.json', async () => {
  const user = tmp('vrm-user-');
  const src = tmp('vrm-src-');
  fs.writeFileSync(path.join(src, 'DeepSeek Whale.vrm'), vrm1());
  // a single file: every all-ages outfit, never an adult one
  const r = await I.importVrm({ src: path.join(src, 'DeepSeek Whale.vrm'), speciesId: 'dafeiyu', userDir: user });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.pack.id, 'vrm-dafeiyu-deepseek', 'the id comes from the model name in its meta');
  assert.match(P.vrmPackId('dafeiyu', '小肥鱼'), /^vrm-dafeiyu-[0-9a-f]{8}$/, 'a name without latin letters gets a hash');
  assert.ok(r.pack.dir.startsWith(user + path.sep));
  assert.deepEqual(r.outfits, ['daily'], 'one model is one look: it dresses only her default outfit, not all 13');
  assert.equal(r.license.redistributable, false);
  assert.equal(r.meta.authors[0], '木子惡魔');
  const manifest = JSON.parse(fs.readFileSync(path.join(r.pack.dir, 'pack.json'), 'utf8'));
  assert.equal(manifest.kind, 'vrm');
  assert.equal(manifest.adult, undefined);
  assert.equal(manifest.vrm.outfits.daily, 'models/DeepSeek_Whale.vrm');
  assert.ok(fs.readFileSync(path.join(r.pack.dir, 'models', 'DeepSeek_Whale.vrm')).equals(vrm1()), 'the model is copied byte for byte (never modified)');
  const loaded = P.loadPacks([{ dir: user, source: 'user' }]);
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.packs.get(r.pack.id).vrm.license.author, '木子惡魔');
  // the same model again replaces it
  const again = await I.importVrm({ src: path.join(src, 'DeepSeek Whale.vrm'), speciesId: 'dafeiyu', userDir: user, packs: new Map([[r.pack.id, { source: 'user' }]]) });
  assert.deepEqual([again.pack.id, again.replaced], [r.pack.id, true]);

  // a folder of models named by outfit: each dresses its outfit; adult-named files are left out
  const wardrobe = tmp('vrm-wardrobe-');
  fs.mkdirSync(path.join(wardrobe, 'fish', '__MACOSX'), { recursive: true });
  for (const n of ['daily', 'pajamas', 'maid']) fs.writeFileSync(path.join(wardrobe, 'fish', `${n}.vrm`), vrm1(FREE_META));
  fs.writeFileSync(path.join(wardrobe, 'fish', '__MACOSX', 'daily.vrm'), 'junk');
  assert.deepEqual(I.findVrmFiles(wardrobe), ['fish/daily.vrm', 'fish/maid.vrm', 'fish/pajamas.vrm']);
  const w = await I.importVrm({ src: wardrobe, speciesId: 'grok', userDir: user });
  assert.equal(w.ok, true, JSON.stringify(w.errors));
  assert.equal(w.pack.id, 'vrm-grok-free-fish');
  assert.deepEqual(w.outfits.sort(), ['daily', 'pajamas']);

  // a .zip of a folder
  const zip = path.join(tmp('vrm-zip-'), 'fish.zip');
  execFileSync('python3', ['-I', '-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("Fish/model.vrm", open(sys.argv[2],"rb").read())\nz.close()', zip, path.join(src, 'DeepSeek Whale.vrm')]);
  const z = await I.importVrm({ src: zip, speciesId: 'claude', userDir: user });
  assert.equal(z.ok, true, JSON.stringify(z.errors));
  assert.equal(z.pack.species, 'claude');
  assert.ok(fs.existsSync(path.join(user, z.pack.id, 'models', 'model.vrm')));

  // refusals: nothing is copied
  const bad = tmp('vrm-badsrc-');
  fs.writeFileSync(path.join(bad, 'fake.vrm'), PNG);
  fs.writeFileSync(path.join(bad, 'plain.vrm'), glb({ asset: { version: '2.0' } }));
  const before = fs.readdirSync(user).sort();
  assert.match((await I.importVrm({ src: path.join(bad, 'fake.vrm'), speciesId: 'dafeiyu', userDir: user })).errors[0], /fake\.vrm：not a glTF binary/);
  assert.match((await I.importVrm({ src: path.join(bad, 'plain.vrm'), speciesId: 'dafeiyu', userDir: user })).errors[0], /not a VRM model/);
  assert.match((await I.importVrm({ src: bad, speciesId: 'dafeiyu', userDir: user })).errors[0], /找到 2 个 \.vrm/);
  assert.match((await I.importVrm({ src: path.join(bad, 'x.txt'), speciesId: 'dafeiyu', userDir: user })).errors[0], /请选择 \.vrm/);
  assert.match((await I.importVrm({ src: tmp('vrm-empty-'), speciesId: 'dafeiyu', userDir: user })).errors[0], /没有找到 \.vrm/);
  assert.deepEqual(fs.readdirSync(user).sort(), before);
  // a built-in id is never replaced
  const id = P.vrmPackId('dafeiyu', '蓝色小肥鱼Deepseek');
  assert.match((await I.importVrm({ src: path.join(src, 'DeepSeek Whale.vrm'), speciesId: 'dafeiyu', userDir: user, packs: new Map([[id, { source: 'builtin' }]]) })).errors[0], /内置角色包/);
});

test('the importer never writes into the app folder (src/ or the repository)', async () => {
  const src = tmp('vrm-src2-');
  fs.writeFileSync(path.join(src, 'm.vrm'), vrm1());
  assert.equal(I.APP_ROOT, ROOT);
  for (const userDir of [BUILTIN, path.join(ROOT, 'src'), ROOT, path.join(ROOT, 'packs')]) {
    const r = await I.importVrm({ src: path.join(src, 'm.vrm'), speciesId: 'dafeiyu', userDir });
    assert.deepEqual(r, { ok: false, errors: ['角色包只能导入到用户数据目录，不会写进应用目录'] }, userDir);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'packs')), false);
});

test('packaging guard: no .vrm in src/ or tracked by git, and the build excludes .vrm files', () => {
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.vrm$/i.test(e.name)) found.push(f); } };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(found, [], 'no VRM model inside src/ (it would ship in the app)');
  let tracked = '';
  try { tracked = execFileSync('git', ['ls-files', '*.vrm', '*.VRM', '**/*.vrm', '**/*.VRM'], { cwd: ROOT, encoding: 'utf8' }); } catch { /* not a git checkout */ }
  assert.equal(tracked.trim(), '', 'no VRM model tracked by git');
  const build = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build;
  assert.ok(build.files.includes('!**/*.vrm') && build.files.includes('!**/*.VRM'), 'electron-builder files exclude .vrm');
  assert.ok(build.files.indexOf('!**/*.vrm') > build.files.indexOf('src/**/*'), 'the exclusion comes after the include so it applies');
  assert.equal(/^\*\.vrm$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')), true, '.gitignore keeps .vrm out of commits');
});

test('PetService: a VRM look is worn, listed with its license, and its adult outfits follow the app (18+ gate, 好感, enforce on switch-off)', async () => {
  const { LhClient, cleanEnv } = require('../src/core/lh-client');
  const { Store } = require('../src/core/store');
  const { SettingsStore } = require('../src/core/settings');
  const { PetService } = require('../src/main/pet-service');
  const dir = tmp('vrm-svc-');
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const root = path.join(dir, 'packs');
  const whale = P.readPack(writeVrmPack(root, vrmPack({ id: 'vrm-whale', outfits: { daily: 'preview.png' } }), { 'model.vrm': vrm1(), 'preview.png': PNG })).pack;
  const adultPack = P.readPack(writeVrmPack(root, vrmPack({ id: 'vrm-free-adult', adult: true, vrm: { outfits: { daily: 'model.vrm', maid: 'maid.vrm' } } }), { 'model.vrm': vrm1(FREE_META), 'maid.vrm': vrm1(FREE_META) })).pack;
  const packs = new Map([...P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]).packs, [whale.id, { ...whale, source: 'user' }], [adultPack.id, { ...adultPack, source: 'user' }]]);
  const data = path.join(dir, 'data');
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(data), settingsStore: new SettingsStore(data), packs, now: () => Date.now(), rnd: () => 0.5 });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: 'dafeiyu', name: '小鱼' });
  svc.answerAgeGate(true);
  svc.setAdultContent(false);

  // the whale model: worn in daily, listed with author and restrictions
  assert.equal(svc.setAppearance('vrm-whale', 'dafeiyu').ok, true);
  let v = svc.view();
  assert.equal(v.look.kind, 'vrm');
  assert.equal(v.look.vrm.license.author, '木子惡魔');
  const opt = svc.appearanceView('dafeiyu').options.find((x) => x.id === 'vrm-whale');
  assert.deepEqual([opt.author, opt.vrm.redistributable, opt.vrm.adultOk], ['木子惡魔', false, false]);

  // the 18+ VRM pack: not selectable with adult content off
  assert.deepEqual(svc.setAppearance('vrm-free-adult', 'dafeiyu'), { ok: false, reason: 'adult' });
  svc.setAdultContent(true);
  assert.equal(svc.setAppearance('vrm-free-adult', 'dafeiyu').ok, true);
  v = svc.view();
  const maid = v.outfits.find((x) => x.id === 'maid');
  assert.equal(maid.locked, true, 'adult outfits still wait for 暧昧');
  assert.equal(maid.look.model, undefined, 'a locked VRM outfit hands out no model to load');
  assert.equal(svc.equipOutfit('maid').ok, false);
  svc.debugSet({ affection: 70 });
  assert.equal(svc.equipOutfit('maid').ok, true);
  assert.equal(svc.view().look.model, 'pack://vrm-free-adult/maid.vrm');
  // adult content off: her look leaves the 18+ pack and the adult outfit comes off
  svc.setAdultContent(false);
  v = svc.view();
  assert.notEqual(v.look && v.look.packId, 'vrm-free-adult');
  assert.equal(v.outfit, 'daily');
  assert.equal(v.outfits.some((x) => x.id === 'maid'), false);
});

// T-2654: 木子惡魔's real model carries meta.version "undefined" (an exporter placeholder); the license panel
// showed 「蓝色小肥鱼Deepseek（undefined）」. A placeholder version is no version.
test('a placeholder meta.version ("undefined", "null", "-") is read as empty and not shown next to the name', () => {
  for (const v of ['undefined', 'null', ' - ', 'N/A', '']) assert.equal(V.inspectVrm(vrm1({ ...FREE_META, version: v })).meta.version, '', v);
  assert.equal(V.inspectVrm(vrm1({ ...FREE_META, version: '1.2' })).meta.version, '1.2');
  const U = require('../src/core/vrm-ui');
  const rows = U.licenseRows(V.inspectVrm(vrm1({ ...FREE_META, name: '蓝色小肥鱼Deepseek', version: 'undefined' })).meta);
  assert.equal(rows.find((r) => r.label === '模型名').text, '蓝色小肥鱼Deepseek');
});

test('one VRM model is one look: no wardrobe of identical cards (packs imported with the old fan-out collapse too)', async () => {
  const root = tmp('vrm-onelook-');
  const ALL_AGES = o.OUTFITS.filter((x) => x.rating === 'all').map((x) => x.id);
  // a pack from before the fix: one model under every all-ages outfit
  const fanned = vrmPack({ id: 'fanned', vrm: { outfits: Object.fromEntries(ALL_AGES.map((id) => [id, 'model.vrm'])) } });
  const r = P.readPack(writeVrmPack(root, fanned, { 'model.vrm': vrm1() }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const look = P.lookContext(r.pack);
  assert.deepEqual(look, { adult: false, only: true, outfits: ['daily'] });
  const p = pet(100);
  for (const s of [ADULT_OFF, ADULT_ON]) {
    assert.deepEqual(o.listOutfits(p, s, look).map((x) => x.id), ['daily'], 'the wardrobe has one entry, so the UI hides 衣柜');
    assert.equal(o.equipOutfit(p, s, 'pajamas', look).reason, 'unavailable');
    assert.equal(o.equipOutfit(p, s, 'maid', look).ok, false);
    assert.deepEqual(o.outfitsForStages(['familiar', 'close', 'flirty', 'lover'], p, s, look), [], 'a stage-up never announces outfits she cannot wear');
  }
  // she was wearing pajamas from the fanned-out wardrobe: back into daily
  p.equippedOutfit = 'pajamas';
  assert.equal(o.wornOutfit(p, ADULT_OFF, look), 'daily');
  assert.deepEqual(o.enforceOutfit(p, ADULT_OFF, look), { changed: true, from: 'pajamas', to: 'daily' });

  // several distinct models: one entry each, daily first; a model repeated under another outfit is not a second card
  const multi = vrmPack({ id: 'multi', vrm: { outfits: { pajamas: 'b.vrm', daily: 'a.vrm', casual: 'a.vrm' } } });
  const m = P.readPack(writeVrmPack(root, multi, { 'a.vrm': vrm1(), 'b.vrm': vrm1() }));
  assert.equal(m.ok, true, JSON.stringify(m.errors));
  assert.deepEqual(P.lookContext(m.pack).outfits, ['daily', 'pajamas']);

  // 2D packs keep her own wardrobe
  assert.equal(P.lookContext({ kind: 'sprites', outfits: { daily: 'x' } }), null);
});
