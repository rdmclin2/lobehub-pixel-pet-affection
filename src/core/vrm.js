'use strict';

// VRM models (角色包 kind "vrm"): reading a .vrm file without three.js. A .vrm is a glTF binary (GLB): a
// 12-byte header ("glTF", version 2, length), then a JSON chunk and a BIN chunk. Everything the app needs
// before drawing — who made the model, what its license allows, which expressions it has — is in the JSON
// chunk under extensions.VRMC_vrm (VRM 1.0) or extensions.VRM (VRM 0.x). This module reads that, turns
// both versions into one meta shape, and derives the restrictions the app enforces (vrmLicense). The
// license comes from the model file itself, never from pack.json, so a pack cannot loosen it.
// Electron-free and three-free so it can be tested; format: docs/pet-packs.md "VRM 角色包".

const fs = require('node:fs');

const GLB_MAGIC = 0x46546c67; // "glTF" little-endian
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const MAX_JSON_BYTES = 64 * 1024 * 1024;

// Is `buf` (at least its first 12 bytes) a glTF 2 binary?
function isGlb(buf) {
  return !!buf && buf.length >= 12 && buf.readUInt32LE(0) === GLB_MAGIC && buf.readUInt32LE(4) === 2;
}

// The glTF JSON of a GLB held in memory. Throws with a reason when it is not one.
function readGlbJson(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('not a buffer');
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a glTF binary (no "glTF" magic)');
  if (buf.readUInt32LE(4) !== 2) throw new Error(`glTF binary version ${buf.readUInt32LE(4)} is not 2`);
  if (buf.length < 20) throw new Error('glTF binary has no JSON chunk');
  const len = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== CHUNK_JSON) throw new Error('the first glTF chunk is not JSON');
  if (len > MAX_JSON_BYTES || 20 + len > buf.length) throw new Error('the glTF JSON chunk is truncated');
  try {
    return JSON.parse(buf.subarray(20, 20 + len).toString('utf8').replace(/[\0 ]+$/, ''));
  } catch {
    throw new Error('the glTF JSON chunk is not valid JSON');
  }
}

// The glTF JSON of a .vrm on disk, reading only the header and the JSON chunk (models are tens of MB).
function readGlbJsonFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    const n = fs.readSync(fd, head, 0, 20, 0);
    if (n < 12 || !isGlb(head)) throw new Error('not a glTF binary (no "glTF" magic)');
    if (n < 20) throw new Error('glTF binary has no JSON chunk');
    const len = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== CHUNK_JSON) throw new Error('the first glTF chunk is not JSON');
    if (len > MAX_JSON_BYTES) throw new Error('the glTF JSON chunk is too large');
    const body = Buffer.alloc(len);
    if (fs.readSync(fd, body, 0, len, 20) !== len) throw new Error('the glTF JSON chunk is truncated');
    return readGlbJson(Buffer.concat([head, body]));
  } finally {
    fs.closeSync(fd);
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v, max = 200) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => str(x, max)).filter(Boolean).slice(0, 16);
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

const AVATAR_PERMISSIONS = ['onlyAuthor', 'onlySeparatelyLicensedPerson', 'everyone'];
const COMMERCIAL_USAGES = ['personalNonProfit', 'personalProfit', 'corporation'];
const CREDIT_NOTATIONS = ['required', 'unnecessary'];
const MODIFICATIONS = ['prohibited', 'allowModification', 'allowModificationRedistribution'];

// VRM 1.0 meta (VRMC_vrm-1.0 spec). Missing fields take the spec's defaults, which are the strict ones.
function meta10(m, specVersion) {
  return {
    vrmVersion: '1.0',
    specVersion: str(specVersion, 20) || '1.0',
    name: str(m.name, 100),
    version: str(m.version, 40),
    authors: strs(m.authors, 100),
    copyrightInformation: str(m.copyrightInformation, 300),
    contactInformation: str(m.contactInformation, 300),
    references: strs(m.references, 300),
    thirdPartyLicenses: str(m.thirdPartyLicenses, 500),
    licenseName: '',
    licenseUrl: str(m.licenseUrl, 300),
    otherLicenseUrl: str(m.otherLicenseUrl, 300),
    avatarPermission: pick(m.avatarPermission, AVATAR_PERMISSIONS, 'onlyAuthor'),
    allowExcessivelyViolentUsage: bool(m.allowExcessivelyViolentUsage, false),
    allowExcessivelySexualUsage: bool(m.allowExcessivelySexualUsage, false),
    commercialUsage: pick(m.commercialUsage, COMMERCIAL_USAGES, 'personalNonProfit'),
    allowPoliticalOrReligiousUsage: bool(m.allowPoliticalOrReligiousUsage, false),
    allowAntisocialOrHateUsage: bool(m.allowAntisocialOrHateUsage, false),
    creditNotation: pick(m.creditNotation, CREDIT_NOTATIONS, 'required'),
    allowRedistribution: bool(m.allowRedistribution, false),
    modification: pick(m.modification, MODIFICATIONS, 'prohibited'),
  };
}

// VRM 0.x meta (UniVRM 0.x: note the spec's own "Ussage" spelling). 0.x has one licenseName instead of
// separate redistribution / modification / credit fields; they are derived from it, and what it does not
// say (Redistribution_Prohibited, Other, unknown) is read the strict way. 0.x has no political / antisocial
// fields, so those are not allowed.
const LICENSES_0X = {
  Redistribution_Prohibited: { allowRedistribution: false, modification: 'prohibited', creditNotation: 'required' },
  CC0: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'unnecessary' },
  CC_BY: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required' },
  CC_BY_NC: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required', nonCommercial: true },
  CC_BY_SA: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required' },
  CC_BY_NC_SA: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required', nonCommercial: true },
  CC_BY_ND: { allowRedistribution: true, modification: 'prohibited', creditNotation: 'required' },
  CC_BY_NC_ND: { allowRedistribution: true, modification: 'prohibited', creditNotation: 'required', nonCommercial: true },
};
const STRICT_0X = { allowRedistribution: false, modification: 'prohibited', creditNotation: 'required' };
const ALLOWED_USERS_0X = { OnlyAuthor: 'onlyAuthor', ExplicitlyLicensedPerson: 'onlySeparatelyLicensedPerson', Everyone: 'everyone' };
function meta0x(m, specVersion) {
  const licenseName = str(m.licenseName, 60);
  const lic = LICENSES_0X[licenseName] || STRICT_0X;
  const commercial = m.commercialUssageName === 'Allow' && !lic.nonCommercial ? 'personalProfit' : 'personalNonProfit';
  return {
    vrmVersion: '0.x',
    specVersion: str(specVersion, 20) || '0.0',
    name: str(m.title, 100),
    version: str(m.version, 40),
    authors: strs(m.author, 100),
    copyrightInformation: '',
    contactInformation: str(m.contactInformation, 300),
    references: strs(m.reference, 300),
    thirdPartyLicenses: '',
    licenseName,
    licenseUrl: str(m.otherPermissionUrl, 300),
    otherLicenseUrl: str(m.otherLicenseUrl, 300),
    avatarPermission: ALLOWED_USERS_0X[m.allowedUserName] || 'onlyAuthor',
    allowExcessivelyViolentUsage: m.violentUssageName === 'Allow',
    allowExcessivelySexualUsage: m.sexualUssageName === 'Allow',
    commercialUsage: commercial,
    allowPoliticalOrReligiousUsage: false,
    allowAntisocialOrHateUsage: false,
    creditNotation: lic.creditNotation,
    allowRedistribution: lic.allowRedistribution,
    modification: lic.modification,
  };
}

// The normalised meta of a glTF JSON, or null when it carries no VRM extension.
function vrmMetaFromJson(json) {
  const ext = (json && json.extensions) || {};
  if (ext.VRMC_vrm && typeof ext.VRMC_vrm === 'object') return meta10(ext.VRMC_vrm.meta || {}, ext.VRMC_vrm.specVersion);
  if (ext.VRM && typeof ext.VRM === 'object') return meta0x(ext.VRM.meta || {}, ext.VRM.specVersion);
  return null;
}

// VRM 1.0 preset expressions (18). VRM 0.x blend shape presets map onto them.
const VRM_PRESET_EXPRESSIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral'];
const PRESETS_0X = { joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed', surprised: 'surprised', a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', blink: 'blink', blink_l: 'blinkLeft', blink_r: 'blinkRight', lookup: 'lookUp', lookdown: 'lookDown', lookleft: 'lookLeft', lookright: 'lookRight', neutral: 'neutral' };
const EXPR_NAME_RE = /^[^\u0000-\u001f]{1,64}$/;

// Expression names the model has: VRM 1.0 preset + custom names; 0.x presets in their 1.0 names, custom
// groups by name. The renderer (three-vrm) uses the same names.
function vrmExpressionsFromJson(json) {
  const ext = (json && json.extensions) || {};
  const out = [];
  const add = (n) => { if (typeof n === 'string' && EXPR_NAME_RE.test(n) && !out.includes(n)) out.push(n); };
  if (ext.VRMC_vrm) {
    const e = ext.VRMC_vrm.expressions || {};
    for (const n of Object.keys(e.preset || {})) if (VRM_PRESET_EXPRESSIONS.includes(n)) add(n);
    for (const n of Object.keys(e.custom || {})) add(n);
  } else if (ext.VRM) {
    const groups = (ext.VRM.blendShapeMaster && ext.VRM.blendShapeMaster.blendShapeGroups) || [];
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g) continue;
      const preset = PRESETS_0X[String(g.presetName || '').toLowerCase()];
      add(preset || g.name);
    }
  }
  return out.slice(0, 128);
}

// Does the model have SpringBone (secondary motion) data? Only reported; the renderer uses it.
function vrmHasSpringBone(json) {
  const ext = (json && json.extensions) || {};
  return !!(ext.VRMC_springBone || (ext.VRM && ext.VRM.secondaryAnimation && Array.isArray(ext.VRM.secondaryAnimation.boneGroups) && ext.VRM.secondaryAnimation.boneGroups.length));
}

// Everything about a .vrm the app keeps: { ok: true, meta, expressions, springBone } or { ok: false, errors }.
function inspectVrmJson(json) {
  const meta = vrmMetaFromJson(json);
  if (!meta) return { ok: false, errors: ['not a VRM model: the glTF has no VRMC_vrm (1.0) or VRM (0.x) extension'] };
  return { ok: true, meta, expressions: vrmExpressionsFromJson(json), springBone: vrmHasSpringBone(json) };
}
function inspectVrm(buf) {
  try { return inspectVrmJson(readGlbJson(buf)); } catch (e) { return { ok: false, errors: [e.message] }; }
}
function inspectVrmFile(file) {
  try { return inspectVrmJson(readGlbJsonFile(file)); } catch (e) { return { ok: false, errors: [e.code === 'ENOENT' ? 'missing' : e.message] }; }
}

// The restrictions a model's license puts on the app, as shown to the user (zh-CN) and enforced by it.
// Each: { id, text, enforced } — `enforced` names what the app does about it.
const COMMERCIAL_LABEL = { personalNonProfit: '仅限个人非商业使用', personalProfit: '个人可商用，法人/企业不可', corporation: '个人与企业均可商用' };
const PERMISSION_LABEL = { onlyAuthor: '仅作者本人可扮演', onlySeparatelyLicensedPerson: '仅获作者单独授权的人可扮演', everyone: '任何人可扮演' };
function vrmRestrictions(meta) {
  const r = [];
  const add = (id, text, enforced) => r.push({ id, text, enforced });
  if (!meta.allowRedistribution) add('no-redistribution', '不可再分发：仅限本机使用，不会被打包/分享/导出', 'share-blocked');
  if (meta.modification === 'prohibited') add('no-modification', '禁止修改：应用只做运行时表情/姿态驱动，不改写模型文件', 'runtime-only');
  else if (meta.modification === 'allowModification') add('no-modified-redistribution', '可修改但不可分发修改版：应用不改写也不导出模型文件', 'runtime-only');
  if (meta.creditNotation === 'required') add('credit-required', `需署名：界面会显示作者${meta.authors.length ? `（${meta.authors.join('、')}）` : ''}`, 'show-author');
  if (meta.commercialUsage === 'personalNonProfit') add('personal-non-profit', '仅限个人非商业', 'notice');
  else if (meta.commercialUsage === 'personalProfit') add('personal-profit', '个人可商用，企业/法人不可商用', 'notice');
  if (!meta.allowExcessivelySexualUsage) add('no-sexual', '禁止性表现：该模型在 18+ 内容/成人服饰下不可用（由应用强制）', 'adult-blocked');
  if (!meta.allowExcessivelyViolentUsage) add('no-violent', '禁止过度暴力表现', 'notice');
  if (!meta.allowPoliticalOrReligiousUsage) add('no-political', '禁止用于政治或宗教目的', 'notice');
  if (!meta.allowAntisocialOrHateUsage) add('no-antisocial', '禁止用于反社会或仇恨表现', 'notice');
  if (meta.avatarPermission !== 'everyone') add('avatar-permission', `${PERMISSION_LABEL[meta.avatarPermission]}：导入即表示你确认自己有权在本机使用该模型`, 'notice');
  if (meta.otherLicenseUrl) add('other-license', `另有条款：${meta.otherLicenseUrl}`, 'notice');
  return r;
}

// The license summary kept with the pack for the UI: one line, the restriction list and the two switches
// the app enforces (redistributable → share/export; adultOk → 18+ looks and adult outfits).
function vrmLicense(meta) {
  const restrictions = vrmRestrictions(meta);
  const who = meta.authors.length ? meta.authors.join('、') : '未署名';
  const base = meta.licenseName ? `VRM ${meta.vrmVersion} · ${meta.licenseName}` : `VRM ${meta.vrmVersion} 授权`;
  const parts = [COMMERCIAL_LABEL[meta.commercialUsage], meta.allowRedistribution ? '可再分发' : '不可再分发', meta.modification === 'prohibited' ? '禁止修改' : '可修改', meta.creditNotation === 'required' ? '需署名' : '无需署名'];
  return {
    summary: `${base}：${parts.join(' / ')}`,
    author: who,
    licenseUrl: meta.licenseUrl || '',
    otherLicenseUrl: meta.otherLicenseUrl || '',
    redistributable: meta.allowRedistribution === true,
    adultOk: meta.allowExcessivelySexualUsage === true,
    creditRequired: meta.creditNotation === 'required',
    restrictions,
  };
}

module.exports = {
  GLB_MAGIC, VRM_PRESET_EXPRESSIONS, AVATAR_PERMISSIONS, COMMERCIAL_USAGES, CREDIT_NOTATIONS, MODIFICATIONS,
  isGlb, readGlbJson, readGlbJsonFile, vrmMetaFromJson, vrmExpressionsFromJson, vrmHasSpringBone,
  inspectVrm, inspectVrmFile, inspectVrmJson, vrmRestrictions, vrmLicense,
};
