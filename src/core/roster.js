'use strict';

// 角色列表 for the admin console (docs/admin-console-design.md §3.2): one row per character — every look is a
// character of its own since T-2764 (core/characters.js: 「大肥鱼 · 像素」, 「大肥鱼 · Live2D」 …) — built from
// what PetService already exposes (view().characters, settingsView().ttsStatus.packs) plus the character
// files. No data of its own: the rows are derived again on every `update` / `settings` broadcast.

const { SPECIES } = require('./species');
const C = require('./characters');

const KIND_LABEL = { sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' };
const SOURCE_LABEL = { builtin: '内置', download: '下载', user: '导入' };
const SOURCE_ORDER = { user: 0, download: 1, builtin: 2 };
const ENGINE_LABEL = { fish: 'Fish Audio', minimax: 'MiniMax', elevenlabs: 'ElevenLabs', local: '本地语音服务', system: '系统语音' };

// What the list shows as her picture: a sprite sheet's first frame, a picture, or the first frame of her
// idle clip (a video character). URLs are pack:// (served to every window) or relative to the console page.
// `clips`: whether no look means her clips (a video character, `<base>-clips`); any other character without a
// look has no picture yet.
function previewOf(sp, look, clips = true) {
  if (!look) {
    if (!clips) return null;
    const idle = sp && sp.clips ? [].concat(sp.clips.idle)[0] : null;
    return idle ? { type: 'video', url: `${sp.clipDir}/${idle}` } : null;
  }
  if (look.kind === 'sprites') return { type: 'sprite', url: look.url, frame: { width: look.frame.width, height: look.frame.height }, actions: look.actions || null, pixelated: !!look.pixelated };
  if (!look.url) return null; // a VRM model without a saved picture yet
  return { type: 'image', url: look.url, pixelated: !!look.pixelated };
}

// 语音包 (core/voice-pack.js resolvePack): what a pack is to her — her own (专属), a generic one (通用·男 / 通用·女)
// or another character's own one (picked by the owner).
const GENDER_LABEL = { male: '男', female: '女' };
function packLabel(p, base) {
  if (!p) return '';
  if (p.kind === 'generic') return `通用·${GENDER_LABEL[p.gender] || '女'}`;
  if (p.character === base) return '专属';
  const sp = SPECIES[p.character];
  return `${sp ? sp.nameZh : p.character} 的专属`;
}
const PICK_SOURCE_LABEL = { user: '手动指定', own: '自动', generic: '自动回退' };

// Her 语音包 now: `state` is main.js voicePackState(her base) — the owner's pick > her own > the generic one of
// her gender; without it (no app around: tests, the roster before the first hatch) her own pack, as before.
// `packs`: settingsView().ttsStatus.packs (VoicePacks.list()) for what the state leaves out (credit, built-in).
function voicePackFor(id, packs, state = null) {
  const list = Array.isArray(packs) ? packs : [];
  const ref = state ? state.pack : list.find((x) => x.character === id && x.kind !== 'generic');
  if (!ref) return null;
  const p = { ...(list.find((x) => x.id === ref.id) || {}), ...ref };
  const source = state ? state.source : 'own';
  return { id: p.id, name: p.name, engine: p.engine, engineLabel: ENGINE_LABEL[p.engine] || p.engine, lines: p.lines, builtIn: !!p.builtIn, credit: p.credit || '', kind: p.kind || 'character', gender: p.gender || null, label: packLabel(p, id), source, sourceLabel: PICK_SOURCE_LABEL[source] || '' };
}

// What the 语音包 picker offers her: 自动（按性别）, her own pack, the generic male / female ones (the owner's from
// userData/voicepacks included: VoicePacks.list() keeps the one in use per id), then other characters' own ones.
function voicePackPick(id, packs, state = null) {
  const list = Array.isArray(packs) ? packs : [];
  const rank = (p) => (p.kind === 'generic' ? (p.gender === 'male' ? 1 : 2) : p.character === id ? 0 : 3);
  const options = list
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind || 'character', gender: p.gender || null, character: p.character || null, lines: p.lines, builtIn: !!p.builtIn, label: packLabel(p, id), group: rank(p) === 0 ? 'own' : rank(p) < 3 ? 'generic' : 'other' }))
    .sort((a, b) => rank(a) - rank(b));
  return {
    choice: state ? state.choice : 'auto',
    missing: state ? state.missing || null : null,
    gender: state ? state.gender || null : null,
    genderSource: state ? state.genderSource || null : null,
    engineVoice: state ? state.engineVoice || null : null,
    options,
  };
}

function packKinds(options) {
  const out = {};
  for (const o of Array.isArray(options) ? options : []) {
    const k = out[o.kind] || (out[o.kind] = { kind: o.kind, label: KIND_LABEL[o.kind] || o.kind, builtin: 0, user: 0 });
    k[o.source === 'user' ? 'user' : 'builtin'] += 1;
  }
  return Object.values(out);
}

function outfitRow(sp, o) {
  return { id: o.id, label: o.label, desc: o.desc || '', stageName: o.stageName || '', rating: o.rating || null, locked: !!o.locked, condition: o.condition || null, equipped: !!o.equipped, isNew: !!o.isNew, preview: o.look ? previewOf(sp, o.look) : null };
}

function outfitList(sp, c, view, outfitsOf) {
  const list = c.current && view && Array.isArray(view.outfits) ? view.outfits : c.met && outfitsOf ? outfitsOf(c.id) : null;
  return Array.isArray(list) ? list.map((o) => outfitRow(sp, o)) : null;
}

// Every built-in character (no imported pack is known without PetService), for a roster before the first hatch.
let builtin = null;
function builtinCharacters() {
  if (!builtin) {
    const P = require('./packs');
    const packs = P.loadPacks([{ dir: require('node:path').join(__dirname, '..', 'renderer', 'packs'), source: 'builtin' }]).packs;
    builtin = C.listCharacters(packs).map((e) => ({ ...e, pack: e.packId && packs.get(e.packId) ? P.packOption(packs.get(e.packId)) : e.clips ? P.clipsOption(e.base) : null, look: e.clips ? null : P.resolveLook(packs, { packId: e.packId, speciesId: e.base, outfitId: 'daily' }) }));
  }
  return builtin;
}

// One row per character, in roster order. `view` = PetService.view(); before the first hatch (no view) the
// rows come from `characters` (PetService.characterList(): id, base, name, kind …) with `look(id)` for the
// picture, every one not met yet. `met`, model, 个性化设定 and 语音包 are her base's (shared by her looks);
// pack, kind, picture and outfits are the character's own. `voicePack(base)`: main.js voicePackState for her
// base (the 语音包 in force and why), so the list and her page show the pack she really uses.
function buildRoster(view, settings, { characters = null, look = null, outfitsOf = null, voicePack = null } = {}) {
  const packs = settings && settings.ttsStatus ? settings.ttsStatus.packs : [];
  const list = view
    ? view.characters
    : (characters || builtinCharacters()).map((x) => ({ ...x, vendor: SPECIES[x.base].vendor, title: SPECIES[x.base].title, accent: SPECIES[x.base].accent, nameZh: SPECIES[x.base].nameZh, current: false, met: null, look: look ? look(x.id) : x.look || null, pack: x.pack || null, model: null, systemRole: '' }));
  return list.map((c) => {
    const base = c.base || c.id;
    const sp = SPECIES[base];
    const opt = c.pack || null;
    const kind = c.kind || (opt ? opt.kind : c.look ? c.look.kind : null);
    const model = c.model ? { current: c.model.current, applied: c.model.applied, chosen: !!c.model.chosen, pending: !!(c.model.current && c.model.applied && c.model.applied !== c.model.current), loaded: c.model.loaded, error: c.model.error || null, options: c.model.options } : null;
    const name = c.name || C.displayName(base, '');
    const vps = voicePack ? voicePack(base) : null;
    return {
      id: c.id,
      base,
      name,
      label: c.label || '',
      nameZh: c.nameZh,
      vendor: c.vendor,
      title: c.title,
      accent: c.accent,
      // 「名字」大肥鱼 · 像素（vendor）once she has a name of her own, as charName() in the pet window
      displayName: c.met && c.met.name !== c.nameZh ? `「${c.met.name}」${name}（${c.vendor}）` : `${name}（${c.vendor}）`,
      current: !!c.current,
      met: c.met,
      preview: previewOf(sp, c.look, kind === 'video'),
      // her face for lists and chat bubbles (T-2839): the drawn avatar of a built-in character for the looks her
      // character file lists (art.packs: pixel, classic, Live2D … all drawn after the same design) and her clips;
      // any other look (imported, or a store VRM / Live2D on her base) keeps its own picture (null here)
      avatar: sp && sp.avatar && (!opt || opt.id === `${base}-clips` || (sp.packs || []).includes(opt.id)) ? sp.avatar : null,
      pack: opt ? { id: opt.id, name: opt.name, kind: opt.kind, adult: !!opt.adult, source: opt.source, author: opt.author, license: opt.license, outfits: opt.outfits || 0, vrm: opt.vrm || null } : null,
      kind,
      kindLabel: KIND_LABEL[kind] || '--',
      source: opt ? opt.source : c.source || 'builtin',
      sourceLabel: SOURCE_LABEL[opt ? opt.source : c.source || 'builtin'],
      // 语音包 (T-4272): the one in force for her base and what the picker offers (自动 / 专属 / 通用·男 / 通用·女)
      voicePack: voicePackFor(base, packs, vps),
      voicePackPick: voicePackPick(base, packs, vps),
      model,
      systemRole: c.systemRole || '',
      blurb: sp ? sp.blurb : '',
      likes: sp ? (Array.isArray(sp.likes) ? sp.likes : String(sp.likes || '').split(/[、,，]/).filter(Boolean)) : [],
      catchphrase: sp ? sp.catchphrase : '',
      credits: sp ? sp.credits || [] : [],
      voice: sp && sp.voice ? { lang: sp.voice.lang, tts: sp.voice.tts || null } : null,
      // 设定: her persona as written in her character file (read-only; the owner's own words are systemRole)
      personality: sp ? sp.personality || '' : '',
      // her own kind (像素 / 图片 / 全动态 / Live2D / VRM / 视频), built-in or imported — one look per character
      packKinds: packKinds(opt ? [opt] : kind ? [{ kind, source: c.source || 'builtin' }] : []),
      // 衣柜 (T-2784): the current character's from PetService.view().outfits, any other met one's from
      // `outfitsOf(id)` (PetService.outfitsOf); null before her base is met
      outfits: outfitList(sp, c, view, outfitsOf),
    };
  });
}

// The view as the console gets it: her needs to the whole number it shows (玩法 rounds them anyway) and
// without the tick clock. Those are the only fields a heartbeat moves, every few seconds by a fraction:
// sent raw, each one was a fresh state that re-rendered the console for nothing it shows.
const NEEDS = ['hunger', 'mood', 'energy'];
function adminView(view) {
  if (!view || !view.pet) return view;
  const { lastTickAt: _t, ...pet } = view.pet;
  for (const k of NEEDS) if (typeof pet[k] === 'number') pet[k] = Math.round(pet[k]);
  return { ...view, pet };
}

// 外观资源: every pet pack, with whose it is and what may be done with it.
function packRows(packStore) {
  const list = packStore instanceof Map ? [...packStore.values()] : Array.isArray(packStore) ? packStore : [];
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    species: p.species,
    speciesName: SPECIES[p.species] ? SPECIES[p.species].nameZh : p.species,
    kind: p.kind,
    kindLabel: KIND_LABEL[p.kind] || p.kind,
    source: p.source,
    sourceLabel: SOURCE_LABEL[p.source] || p.source,
    adult: !!p.adult,
    author: p.author || '',
    license: p.license || '',
    version: p.version || '',
    outfits: Object.keys(p.outfits || {}).length,
    // 删除下载 for a downloaded one (src/main/packs.js removeDownload): it can be downloaded again
    removable: p.source === 'user' || p.source === 'download',
    exportable: p.source === 'user' && !(p.vrm && p.vrm.license && p.vrm.license.redistributable === false),
  })).sort((a, b) => (a.source === b.source ? a.species.localeCompare(b.species) || a.id.localeCompare(b.id) : SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]));
}

module.exports = { buildRoster, packRows, adminView, previewOf, packKinds, voicePackFor, voicePackPick, KIND_LABEL, SOURCE_LABEL, ENGINE_LABEL };
