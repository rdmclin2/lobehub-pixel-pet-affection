'use strict';
// What the 外观 panel says about a VRM pack (角色包 kind "vrm"): the meta line of a pack card, the license
// details of a model (导入确认 and 授权信息), the credit that stays on the card when the license asks for it,
// whether the pack may be exported, and import errors in plain Chinese. The meta and the restriction list
// come from src/core/vrm.js (read from the model file, never from pack.json); this only words them.
// Pure and Electron-free: loaded by the renderer as a <script> (window.PetVrmUi) and by the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmUi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const KIND_LABEL = { sprites: '像素动画', video: '透明视频', rig: '全动态', live2d: 'Live2D', vrm: 'VRM' };

  // The meta line of a pack card. A VRM pack: 『VRM · N 套服饰 · 作者』 (its author read from the model).
  function packMetaLine(o) {
    const adult = o.adult ? '18+ · ' : '';
    const kind = KIND_LABEL[o.kind] || '立绘';
    if (o.kind === 'vrm') return `${adult}VRM · ${o.outfits} 套服饰 · ${(o.vrm && o.vrm.author) || o.author || '未署名'}${o.source === 'user' ? ' · 本地导入' : ''}`;
    return `${adult}${kind} · ${o.outfits} 套服饰 · ${o.author} · ${o.license}${o.source === 'user' ? ' · 导入（内容由作者负责）' : ''}`;
  }

  // Only web links are opened (in the system browser); anything else is shown as text.
  function safeLink(url) {
    if (typeof url !== 'string') return null;
    const u = url.trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null;
  }

  const AVATAR_PERMISSION = { onlyAuthor: '仅作者本人', onlySeparatelyLicensedPerson: '仅获作者单独授权的人', everyone: '任何人' };
  const COMMERCIAL = { personalNonProfit: '仅限个人非商业使用', personalProfit: '个人可商用（企业/法人不可）', corporation: '个人与企业均可商用' };
  const MODIFICATION = { prohibited: '禁止修改', allowModification: '可修改，但不可分发修改版', allowModificationRedistribution: '可修改，也可分发修改版' };
  const yesNo = (v, yes, no) => (v ? yes : no);

  // The rows of a model's license (label, text, optional link) in reading order. Empty fields are left out,
  // except the ones a user must always see (author, the permissions, the license link).
  function licenseRows(meta) {
    const m = meta || {};
    const rows = [];
    const add = (label, text, href = null) => rows.push({ label, text, href });
    const link = (label, url) => { if (url) add(label, url, safeLink(url)); };
    if (m.name) add('模型名', m.version ? `${m.name}（${m.version}）` : m.name);
    add('作者', (m.authors && m.authors.length) ? m.authors.join('、') : '未署名');
    if (m.copyrightInformation) add('版权', m.copyrightInformation);
    if (m.contactInformation) add('联系方式', m.contactInformation, safeLink(m.contactInformation));
    for (const r of m.references || []) add('参考', r, safeLink(r));
    add('谁可以扮演', AVATAR_PERMISSION[m.avatarPermission] || AVATAR_PERMISSION.onlyAuthor);
    add('商用', COMMERCIAL[m.commercialUsage] || COMMERCIAL.personalNonProfit);
    add('再分发', yesNo(m.allowRedistribution === true, '允许', '不允许'));
    add('修改', MODIFICATION[m.modification] || MODIFICATION.prohibited);
    add('署名', yesNo(m.creditNotation !== 'unnecessary', '需要署名', '无需署名'));
    add('性表现', yesNo(m.allowExcessivelySexualUsage === true, '允许', '不允许'));
    add('暴力表现', yesNo(m.allowExcessivelyViolentUsage === true, '允许', '不允许'));
    if (m.licenseName) add('授权', m.licenseName);
    if (m.licenseUrl) link('授权条款', m.licenseUrl);
    else add('授权条款', `VRM ${m.vrmVersion || ''} 默认条款（模型未附链接）`.replace('  ', ' '));
    link('其他条款', m.otherLicenseUrl);
    if (m.thirdPartyLicenses) add('第三方授权', m.thirdPartyLicenses);
    return rows;
  }

  // The restrictions in the order that matters most to the user, each with a tone for the UI: 'block' when
  // the app refuses something because of it, 'info' otherwise.
  const ORDER = ['no-redistribution', 'no-modification', 'no-modified-redistribution', 'credit-required', 'personal-non-profit', 'personal-profit', 'no-sexual', 'avatar-permission', 'no-violent', 'no-political', 'no-antisocial', 'other-license'];
  function restrictionList(restrictions) {
    const list = Array.isArray(restrictions) ? restrictions.slice() : [];
    const rank = (r) => { const i = ORDER.indexOf(r.id); return i < 0 ? ORDER.length : i; };
    return list.sort((a, b) => rank(a) - rank(b)).map((r) => ({ id: r.id, text: r.text, tone: r.enforced === 'share-blocked' || r.enforced === 'adult-blocked' ? 'block' : 'info' }));
  }

  // What stays on the pack card while the license asks for credit; null when it does not.
  function creditLine(vrm) {
    if (!vrm || !vrm.creditRequired) return null;
    return `署名：${vrm.author || '未署名'}（模型授权要求署名）`;
  }

  // May the pack be exported / shared from the UI? Mirrors core/packs.js packShareable (main enforces it too).
  function exportState(o) {
    if (!o) return { ok: false, text: '没有这个角色包' };
    if (o.source !== 'user') return { ok: false, reason: 'builtin', text: '内置角色包随应用提供，不需要导出' };
    if (o.kind === 'vrm' && !(o.vrm && o.vrm.redistributable)) return { ok: false, reason: 'no-redistribution', text: '这个 VRM 模型的授权不允许再分发：仅限本机使用，不能导出或分享' };
    if (o.kind === 'video') return { ok: false, reason: 'builtin', text: '不能导出' };
    return { ok: true };
  }

  // Import errors from main (core/vrm.js, core/vrm-import.js) as a sentence the user can act on.
  const ERRORS = [
    [/no "glTF" magic|not a glTF binary/i, '这不是 VRM 文件：内容不是 glTF 二进制格式（可能只是改了扩展名）'],
    [/version \d+ is not 2/i, '这个 glTF 文件版本太旧（只支持 glTF 2.0 的 VRM）'],
    [/not a VRM model|no VRMC_vrm/i, '这是普通的 glTF/GLB 模型，没有 VRM 信息（缺少 VRMC_vrm / VRM 扩展），请先在 VRoid / UniVRM 里导出为 VRM'],
    [/truncated|has no JSON chunk|not valid JSON|first glTF chunk is not JSON|too large/i, '文件已损坏或不完整（可能没下载完），请重新下载后再导入'],
    [/^missing$|ENOENT|no such file/i, '找不到这个文件：它可能已被移动、删除，或位于无法访问的位置'],
    [/EACCES|EPERM|permission/i, '没有权限读取这个文件，请把它复制到自己的文件夹后再导入'],
  ];
  function importErrorText(errors) {
    const list = (Array.isArray(errors) ? errors : [errors]).filter(Boolean).map(String);
    if (!list.length) return '导入失败：原因未知';
    const out = [];
    for (const e of list.slice(0, 3)) {
      const file = /^([^：]+\.vrm)：(.*)$/i.exec(e);
      const body = file ? file[2] : e;
      const hit = ERRORS.find(([re]) => re.test(body));
      const text = hit ? hit[1] : body;
      out.push(file ? `${file[1]}：${text}` : text);
    }
    return `导入失败：${[...new Set(out)].join('；')}`;
  }

  return { KIND_LABEL, packMetaLine, safeLink, licenseRows, restrictionList, creditLine, exportState, importErrorText };
});
