'use strict';
// The dance library (docs/vrm-dance.md §5): the index of the dances baked from MMD / vidol material
// (<dances dir>/library.json, served over vrmlib://dance/library.json) cleaned and listed, the built-in demo
// dance (core/dance-demo.js, made from numbers: no file) and the rules every entry point shares — which
// file names a dance may have, whether it loops by default, who may dance (a VRM look only) and the reason
// told otherwise. Pure; UMD (window.PetVrmDances in the renderer, require() in main and the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmDances = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ID_RE = /^[a-z0-9-]{1,48}$/;
  // the only files a dance folder serves (§5.2): the motion, the music, the cover
  const FILE_RE = /^(dance\.vrma|audio\.(mp3|wav|ogg|m4a|flac)|cover\.(jpg|jpeg|png|webp))$/;
  const SOURCES = ['vidol-pack', 'mmd-folder', 'vmd', 'vrma', 'builtin'];
  const IK = ['on', 'fk', 'mixed'];
  const DEMO_ID = 'demo';
  // a dance without music up to this long loops by default (§4.3)
  const SHORT_LOOP = 15;
  const LOOK_LABEL = { sprites: '像素', rig: '像素', pictures: '图片', video: '像素', live2d: 'Live2D', vrm: 'VRM' };

  const num = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  // "<id>/<file>" of this dance, with a whitelisted file name; anything else is dropped
  function ownFile(id, rel, kind) {
    if (typeof rel !== 'string') return null;
    const m = /^([a-z0-9-]{1,48})\/([^/\\]+)$/.exec(rel);
    if (!m || m[1] !== id || !FILE_RE.test(m[2])) return null;
    if (kind === 'motion' && m[2] !== 'dance.vrma') return null;
    if (kind === 'audio' && !/^audio\./.test(m[2])) return null;
    if (kind === 'cover' && !/^cover\./.test(m[2])) return null;
    return rel;
  }

  // The built-in demo (§5.4): 「节拍摇摆」, our own keyframes and a synthesized beat, served by main from memory.
  function demoEntry() {
    return { id: DEMO_ID, name: '节拍摇摆', file: `${DEMO_ID}/dance.vrma`, audio: `${DEMO_ID}/audio.wav`, duration: 16, audioDuration: 16, offset: 0, loop: true, credit: '内置示例（原创动作与合成节拍）', face: true, ik: 'fk', extent: { up: 0.651, side: 0.501 }, ground: -0.0173, source: 'builtin', builtin: true };
  }

  // library.json → { schema: 1, dances: { id: entry } }: only well-formed entries, every path checked.
  function cleanDanceIndex(raw) {
    const dances = {};
    const src = raw && raw.dances && typeof raw.dances === 'object' && !Array.isArray(raw.dances) ? raw.dances : {};
    for (const [id, e] of Object.entries(src)) {
      if (!ID_RE.test(id) || id === DEMO_ID || !e || typeof e !== 'object') continue;
      const file = ownFile(id, e.file, 'motion');
      if (!file) continue;
      const duration = num(e.duration, 0, 3600, 0);
      if (!(duration > 0)) continue;
      const d = { id, name: str(e.name, 60) || id, file, duration: +duration.toFixed(3), offset: num(e.offset, -10, 10, 0) };
      const audio = ownFile(id, e.audio, 'audio');
      if (audio) d.audio = audio;
      const cover = ownFile(id, e.cover, 'cover');
      if (cover) d.cover = cover;
      if (audio && typeof e.audioDuration === 'number') d.audioDuration = num(e.audioDuration, 0, 3600, 0);
      d.loop = typeof e.loop === 'boolean' ? e.loop : !audio && duration <= SHORT_LOOP;
      const credit = str(e.credit, 120);
      if (credit) d.credit = credit;
      d.face = e.face === true;
      if (IK.includes(e.ik)) d.ik = e.ik;
      if (e.extent && typeof e.extent === 'object') d.extent = { up: num(e.extent.up, 0, 3, 1), side: num(e.extent.side, 0, 3, 0.8) };
      if (e.stage && typeof e.stage === 'object') d.stage = { radius: num(e.stage.radius, 0, 1, 0.15), clampHits: num(e.stage.clampHits, 0, 1, 0) };
      d.ground = num(e.ground, -0.5, 0.5, 0);
      d.source = SOURCES.includes(e.source) && e.source !== 'builtin' ? e.source : 'vmd';
      const baked = str(e.bakedWith, 40);
      if (baked) d.bakedWith = baked;
      if (typeof e.importedAt === 'string' && !Number.isNaN(Date.parse(e.importedAt))) d.importedAt = e.importedAt;
      dances[id] = d;
    }
    return { schema: 1, dances };
  }

  // Every dance she can dance: the library's, newest import first, then the demo.
  function listDances(index, { demo = true } = {}) {
    const list = Object.values((index && index.dances) || {}).sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')) || a.name.localeCompare(b.name));
    if (demo) list.push(demoEntry());
    return list;
  }

  // What the outside sees of a dance (API, IPC): no paths.
  function publicEntry(e) {
    return { id: e.id, name: e.name, duration: e.duration, music: !!e.audio, cover: !!e.cover, loop: !!e.loop, face: !!e.face, builtin: !!e.builtin, ...(e.credit ? { credit: e.credit } : {}) };
  }

  const fold = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s·・\-_—~～《》「」『』()（）]+/g, '');
  // The dance asked for: by id, else by name (exact, then contained either way), else null.
  function findDance(list, { id, name } = {}) {
    if (id) return list.find((d) => d.id === id) || null;
    const n = fold(name);
    if (!n) return null;
    return list.find((d) => fold(d.name) === n) || list.find((d) => fold(d.name).includes(n) || n.includes(fold(d.name))) || null;
  }

  // One to dance when none was named: not the one just danced (when there is a choice); the library first.
  function pickDance(list, { last = null, rand = Math.random } = {}) {
    const own = list.filter((d) => !d.builtin);
    const pool0 = own.length ? own : list;
    const pool = pool0.length > 1 ? pool0.filter((d) => d.id !== last) : pool0;
    return pool.length ? pool[Math.floor(rand() * pool.length) % pool.length] : null;
  }

  // Who may dance: a VRM look only (§6.3). → null (she can) or { reason: 'not-vrm', kind, message }
  function cannotDance(look) {
    const kind = look && look.kind ? look.kind : null;
    if (kind === 'vrm') return null;
    const label = LOOK_LABEL[kind] || '像素';
    return { reason: 'not-vrm', kind, message: `舞蹈只有 VRM 外观可以跳。她现在是${label}外观，换成 VRM 模型再来吧。` };
  }

  return { ID_RE, FILE_RE, DEMO_ID, SHORT_LOOP, LOOK_LABEL, demoEntry, cleanDanceIndex, listDances, publicEntry, findDance, pickDance, cannotDance };
});
