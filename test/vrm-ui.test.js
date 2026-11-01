'use strict';
// 外观 panel wording for VRM packs (src/core/vrm-ui.js): pack meta line, license rows and links, restriction
// order and tone, the credit kept on the card, the export gate, and import errors in plain Chinese.

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/core/vrm-ui');
const V = require('../src/core/vrm');

// the whale model's license meta (木子惡魔): only the meta, never the model
const WHALE = V.vrmMetaFromJson({ extensions: { VRMC_vrm: { specVersion: '1.0', meta: {
  name: '蓝色小肥鱼Deepseek', version: '1.0.0', authors: ['木子惡魔'], licenseUrl: 'https://vrm.dev/licenses/1.0/',
  avatarPermission: 'onlyAuthor', allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false,
  commercialUsage: 'personalNonProfit', allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false,
  creditNotation: 'required', allowRedistribution: false, modification: 'prohibited',
  references: ['https://github.com/sunfish1728/deepcoin-avatars', 'not a link'], contactInformation: 'mailto:x@y',
  copyrightInformation: '© 木子惡魔',
} } } });
const OPEN = V.vrmMetaFromJson({ extensions: { VRMC_vrm: { specVersion: '1.0', meta: {
  name: 'Open Fish', authors: ['A', 'B'], avatarPermission: 'everyone', commercialUsage: 'corporation', creditNotation: 'unnecessary',
  allowRedistribution: true, modification: 'allowModificationRedistribution', allowExcessivelySexualUsage: true, allowExcessivelyViolentUsage: true,
  allowPoliticalOrReligiousUsage: true, allowAntisocialOrHateUsage: true,
} } } });
const view = (meta) => {
  const l = V.vrmLicense(meta);
  return { author: l.author, summary: l.summary, redistributable: l.redistributable, adultOk: l.adultOk, creditRequired: l.creditRequired, restrictions: l.restrictions, models: [{ file: 'models/a.vrm', meta, restrictions: l.restrictions }] };
};

test('pack meta line: VRM · N 套服饰 · 作者 (author from the model), other kinds unchanged', () => {
  assert.equal(U.packMetaLine({ kind: 'vrm', outfits: 6, author: 'x', source: 'user', vrm: view(WHALE) }), 'VRM · 6 套服饰 · 木子惡魔 · 本地导入');
  assert.equal(U.packMetaLine({ kind: 'vrm', outfits: 2, adult: true, author: 'A、B', source: 'builtin', vrm: view(OPEN) }), '18+ · VRM · 2 套服饰 · A、B');
  assert.equal(U.packMetaLine({ kind: 'sprites', outfits: 9, author: '画师', license: 'CC BY', source: 'builtin' }), '像素动画 · 9 套服饰 · 画师 · CC BY');
  assert.equal(U.packMetaLine({ kind: 'live2d', outfits: 1, author: 'm', license: 'l', source: 'user' }), 'Live2D · 1 套服饰 · m · l · 导入（内容由作者负责）');
  assert.equal(U.packMetaLine({ kind: 'pictures', outfits: 3, author: 'a', license: 'b' }), '立绘 · 3 套服饰 · a · b');
});

test('license rows: name, authors, copyright, contact, references, permissions, clickable license link', () => {
  const rows = U.licenseRows(WHALE);
  const get = (label) => rows.filter((r) => r.label === label);
  assert.equal(get('模型名')[0].text, '蓝色小肥鱼Deepseek（1.0.0）');
  assert.equal(get('作者')[0].text, '木子惡魔');
  assert.equal(get('版权')[0].text, '© 木子惡魔');
  assert.deepEqual(get('联系方式')[0], { label: '联系方式', text: 'mailto:x@y', href: null }, 'only web links are clickable');
  assert.deepEqual(get('参考').map((r) => r.href), ['https://github.com/sunfish1728/deepcoin-avatars', null]);
  assert.equal(get('谁可以扮演')[0].text, '仅作者本人');
  assert.equal(get('商用')[0].text, '仅限个人非商业使用');
  assert.equal(get('再分发')[0].text, '不允许');
  assert.equal(get('修改')[0].text, '禁止修改');
  assert.equal(get('署名')[0].text, '需要署名');
  assert.equal(get('性表现')[0].text, '不允许');
  assert.deepEqual(get('授权条款')[0], { label: '授权条款', text: 'https://vrm.dev/licenses/1.0/', href: 'https://vrm.dev/licenses/1.0/' });
  const open = U.licenseRows(OPEN);
  assert.equal(open.find((r) => r.label === '作者').text, 'A、B');
  assert.equal(open.find((r) => r.label === '商用').text, '个人与企业均可商用');
  assert.equal(open.find((r) => r.label === '再分发').text, '允许');
  assert.equal(open.find((r) => r.label === '授权条款').href, null, 'no licenseUrl: the default terms named, nothing to click');
  assert.match(open.find((r) => r.label === '授权条款').text, /VRM 1\.0 默认条款/);
  assert.equal(U.licenseRows({}).find((r) => r.label === '作者').text, '未署名');
});

test('safeLink: only http(s) URLs', () => {
  assert.equal(U.safeLink(' https://vrm.dev/x '), 'https://vrm.dev/x');
  assert.equal(U.safeLink('http://a.b'), 'http://a.b');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b', 'https://a b', '', null, 3]) assert.equal(U.safeLink(bad), null, String(bad));
});

test('restrictions: the whale model lists 不可再分发 / 禁止修改 / 需署名 / 个人非商业 / 18+ 不可用, enforced ones marked', () => {
  const list = U.restrictionList(V.vrmLicense(WHALE).restrictions);
  assert.deepEqual(list.slice(0, 5).map((r) => r.id), ['no-redistribution', 'no-modification', 'credit-required', 'personal-non-profit', 'no-sexual']);
  assert.match(list[0].text, /^不可再分发/);
  assert.match(list[2].text, /需署名.*木子惡魔/);
  assert.match(list[4].text, /18\+/);
  assert.equal(list.find((r) => r.id === 'no-redistribution').tone, 'block');
  assert.equal(list.find((r) => r.id === 'no-sexual').tone, 'block');
  assert.equal(list.find((r) => r.id === 'credit-required').tone, 'info');
  assert.deepEqual(U.restrictionList(V.vrmLicense(OPEN).restrictions), [], 'a fully open model has none');
  assert.deepEqual(U.restrictionList(undefined), []);
});

test('credit: shown on the card only when the license requires it', () => {
  assert.equal(U.creditLine(view(WHALE)), '署名：木子惡魔（模型授权要求署名）');
  assert.equal(U.creditLine(view(OPEN)), null);
  assert.equal(U.creditLine(null), null);
});

test('export: a non-redistributable VRM pack is refused with the reason; built-in packs are not exported', () => {
  const no = U.exportState({ kind: 'vrm', source: 'user', vrm: view(WHALE) });
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'no-redistribution');
  assert.match(no.text, /不允许再分发/);
  assert.equal(U.exportState({ kind: 'vrm', source: 'user', vrm: view(OPEN) }).ok, true);
  assert.equal(U.exportState({ kind: 'vrm', source: 'user' }).ok, false, 'no license known: refused');
  assert.equal(U.exportState({ kind: 'sprites', source: 'user' }).ok, true);
  assert.equal(U.exportState({ kind: 'sprites', source: 'builtin' }).reason, 'builtin');
});

test('import errors: not a VRM, plain glTF, broken, missing path — each a clear sentence', () => {
  const r = (e) => U.importErrorText(e);
  assert.equal(r(['x.vrm：not a glTF binary (no "glTF" magic)']), '导入失败：x.vrm：这不是 VRM 文件：内容不是 glTF 二进制格式（可能只是改了扩展名）');
  assert.match(r(['m.vrm：not a VRM model: the glTF has no VRMC_vrm (1.0) or VRM (0.x) extension']), /普通的 glTF\/GLB 模型，没有 VRM 信息/);
  assert.match(r(['m.vrm：the glTF JSON chunk is truncated']), /文件已损坏或不完整/);
  assert.match(r(['m.vrm：the glTF JSON chunk is not valid JSON']), /文件已损坏或不完整/);
  assert.match(r(["ENOENT: no such file or directory, stat '/gone/a.vrm'"]), /^导入失败：找不到这个文件/);
  assert.match(r(['m.vrm：missing']), /找不到这个文件/);
  assert.match(r(['EACCES: permission denied']), /没有权限/);
  assert.equal(r(['请选择 .vrm 文件，或包含它的文件夹 / .zip']), '导入失败：请选择 .vrm 文件，或包含它的文件夹 / .zip');
  assert.equal(r([]), '导入失败：原因未知');
  // the real messages of core/vrm.js map
  const fake = V.inspectVrm(Buffer.from('PK not a model at all'));
  assert.match(r([`f.vrm：${fake.errors.join('；')}`]), /这不是 VRM 文件/);
  const gltf = V.inspectVrmJson({ asset: { version: '2.0' } });
  assert.match(r([`g.vrm：${gltf.errors.join('；')}`]), /没有 VRM 信息/);
});
