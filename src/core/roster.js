'use strict';

// 角色列表 for the admin console (docs/admin-console-design.md §3.2): one row per character — every look is a
// character of its own since T-2764 (core/characters.js: 「大肥鱼 · 像素」, 「大肥鱼 · Live2D」 …) — built from
// what PetService already exposes (view().characters, settingsView().ttsStatus.packs) plus the character
// files. No data of its own: the rows are derived again on every `update` / `settings` broadcast.

const { SPECIES } = require('./species');
const C = require('./characters');

const KIND_LABEL = { sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' };
const SOURCE_LABEL = { builtin: '内置', user: '导入' };
const ENGINE_LABEL = { fish: 'Fish Audio', minimax: 'MiniMax', elevenlabs: 'ElevenLabs', local: '本地语音服务', system: '系统语音' };

// What the list shows as her picture: a sprite sheet's first frame, a picture, or the first frame of her
// idle clip (a video character). URLs are pack:// (served to every window) or relative to the console page.
// `clips`: whether no look means her clips (a video character, `<base>-clips`); any other character without a
// look has no picture yet.
function previewOf(sp, look, clips = true) {
  if (!look) {
    if (!clips) return null;
    const idle = sp && sp.clips ? [].concat(sp.clips.idle)[0] : null;
    return idle ? { type: 'video', url: `../renderer/${sp.clipDir}/${idle}` } : null;
  }
  if (look.kind === 'sprites') return { type: 'sprite', url: look.url, frame: { width: look.frame.width, height: look.frame.height }, actions: look.actions || null, pixelated: !!look.pixelated };
  if (!look.url) return null; // a VRM model without a saved picture yet
  return { type: 'image', url: look.url, pixelated: !!look.pixelated };
}

function voicePackFor(id, packs) {
  const p = (Array.isArray(packs) ? packs : []).find((x) => x.character === id);
  return p ? { id: p.id, name: p.name, engine: p.engine, engineLabel: ENGINE_LABEL[p.engine] || p.engine, lines: p.lines, builtIn: !!p.builtIn, credit: p.credit || '' } : null;
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
// pack, kind, picture and outfits are the character's own.
function buildRoster(view, settings, { characters = null, look = null } = {}) {
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
      pack: opt ? { id: opt.id, name: opt.name, kind: opt.kind, adult: !!opt.adult, source: opt.source, author: opt.author, license: opt.license, vrm: opt.vrm || null } : null,
      kind,
      kindLabel: KIND_LABEL[kind] || '--',
      source: opt ? opt.source : 'builtin',
      sourceLabel: SOURCE_LABEL[opt ? opt.source : 'builtin'],
      voicePack: voicePackFor(base, packs),
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
      // 服饰: only the current character's outfits are known (PetService.view().outfits is hers); others null
      outfits: c.current && view && Array.isArray(view.outfits) ? view.outfits.map((o) => outfitRow(sp, o)) : null,
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
    removable: p.source === 'user',
    exportable: p.source === 'user' && !(p.vrm && p.vrm.license && p.vrm.license.redistributable === false),
  })).sort((a, b) => (a.source === b.source ? a.species.localeCompare(b.species) || a.id.localeCompare(b.id) : a.source === 'user' ? -1 : 1));
}

module.exports = { buildRoster, packRows, adminView, previewOf, packKinds, KIND_LABEL, SOURCE_LABEL, ENGINE_LABEL };
