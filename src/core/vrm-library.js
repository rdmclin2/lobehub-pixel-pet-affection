'use strict';
// The VRM motion library (docs/vrm-motion-system.md §3.7, §6): the bake list in the repository
// (src/core/vrm-library.json: ids and metadata, no binaries) and the index the bake writes next to the
// .vrma files (library.json in the user's data folder, served over vrmlib://). This file checks both and
// answers "which clip plays slot X for style Y", falling back when a clip is missing. Pure; UMD like
// vrm-motion.js (window.PetVrmLibrary in the renderer, require() in main and the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmLibrary = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const KINDS = ['posture', 'idle', 'hold', 'reaction'];
  const SETS = ['female', 'male', 'neutral'];
  const MASKS = ['full', 'upper', 'arms', 'head'];
  const ID_RE = /^([a-z]+(?:\.[a-z0-9-]+)+)@(female|male|neutral)$/;
  const SRC_RE = /^(postures|mixamo|motions)\/[^\0]+\.(fbx|vmd)$/i;
  // the postures of this release (P0 needs the first four; sit.* are the resting ones)
  const POSTURES = ['stand.relaxed', 'stand.confident', 'stand.shy', 'stand.playful', 'sit.rest', 'sit.doze'];
  const POSTURE_LABEL = { auto: '自动', 'stand.relaxed': '放松站', 'stand.confident': '叉腰站', 'stand.shy': '害羞站', 'stand.playful': '俏皮站', 'sit.rest': '坐着', 'sit.doze': '靠坐' };

  function parseId(id) {
    const m = ID_RE.exec(String(id || ''));
    if (!m) throw new Error(`bad clip id "${id}" (want <slot>@female|male|neutral)`);
    return { slot: m[1], style: m[2] };
  }

  // Problems of the bake list (empty = fine).
  function validateManifest(m) {
    const out = [];
    if (!m || m.schema !== 1 || !m.clips || typeof m.clips !== 'object') return ['schema 1 with a clips object expected'];
    for (const [id, e] of Object.entries(m.clips)) {
      let p;
      try { p = parseId(id); } catch (err) { out.push(err.message); continue; }
      if (!e || typeof e !== 'object') { out.push(`${id}: not an object`); continue; }
      if (!KINDS.includes(e.kind)) out.push(`${id}: kind "${e.kind}" (known: ${KINDS.join(', ')})`);
      if (e.style !== p.style) out.push(`${id}: style "${e.style}" does not match the id`);
      if (e.src !== undefined) {
        if (typeof e.src !== 'string' || !SRC_RE.test(e.src) || e.src.includes('..') || e.src.startsWith('/') || e.src.includes('\\')) out.push(`${id}: src must be a relative path under postures/, mixamo/ or motions/ (no ..)`);
      } else if (!Array.isArray(e.cycle)) out.push(`${id}: needs a src (a file to bake) or a cycle (postures to go through)`);
      if (e.cycle !== undefined) {
        if (e.kind !== 'idle' || !Array.isArray(e.cycle) || e.cycle.length < 2) out.push(`${id}: cycle is an idle's list of ≥ 2 postures`);
        else for (const s of e.cycle) if (!m.clips[`${s}@${p.style}`]) out.push(`${id}: cycle posture ${s}@${p.style} is not in the list`);
        if (!(e.every >= 8 && e.every <= 30)) out.push(`${id}: every (seconds per posture) must be 8–30`);
      }
      if (e.mask !== undefined && !MASKS.includes(e.mask)) out.push(`${id}: mask "${e.mask}"`);
      if (e.trim !== undefined && !(Array.isArray(e.trim) && e.trim.length === 2 && e.trim[0] >= 0 && e.trim[1] > e.trim[0])) out.push(`${id}: trim [a, b] with 0 ≤ a < b`);
      if (e.amplitude !== undefined && !(e.amplitude > 0 && e.amplitude <= 1.5)) out.push(`${id}: amplitude 0..1.5`);
      if (e.face !== undefined && (typeof e.face !== 'object' || Object.values(e.face).some((w) => !(w >= 0 && w <= 1)))) out.push(`${id}: face weights 0..1`);
    }
    return out;
  }

  // The runtime index (library.json) cleaned: only well-formed entries whose file is a relative .vrma
  // under <style>/ (or file-less cycles). Anything else is dropped, not trusted.
  function cleanIndex(raw) {
    const clips = {};
    const src = raw && raw.clips && typeof raw.clips === 'object' ? raw.clips : {};
    for (const [id, e] of Object.entries(src)) {
      let p;
      try { p = parseId(id); } catch { continue; }
      if (!e || !KINDS.includes(e.kind)) continue;
      const c = { id, slot: p.slot, style: p.style, kind: e.kind, label: typeof e.label === 'string' ? e.label.slice(0, 20) : p.slot, loop: !!e.loop, sit: !!e.sit };
      if (typeof e.file === 'string') {
        if (!/^(female|male|neutral)\/[a-z0-9.-]+\.vrma$/.test(e.file)) continue;
        c.file = e.file;
        c.duration = Number(e.duration) > 0 ? Number(e.duration) : 1;
      } else if (Array.isArray(e.cycle) && e.kind === 'idle') {
        c.cycle = e.cycle.filter((s) => typeof s === 'string').slice(0, 6);
        c.every = Math.max(8, Math.min(30, Number(e.every) || 12));
      } else continue;
      clips[id] = c;
    }
    return { schema: 1, clips };
  }

  // The entry for `slot` in style set `set`: the pack's override (pack.json vrm.motions), then the set's
  // own, then female (neutral borrows the female set, §4.1), then any. null when the library has none.
  function resolve(index, slot, set, overrides = null, usable = null) {
    const clips = (index && index.clips) || {};
    const ok = (id) => !!clips[id] && (!usable || usable(clips[id]));
    const o = overrides && overrides[slot];
    if (o && ok(o)) return clips[o];
    for (const s of [set, set === 'neutral' ? 'female' : null, 'female', 'male', 'neutral']) if (s && ok(`${slot}@${s}`)) return clips[`${slot}@${s}`];
    return null;
  }

  // The slots of one kind the library can play for a set (resolved).
  function slotsOf(index, kind, set, overrides, usable) {
    const slots = new Set(Object.values((index && index.clips) || {}).filter((c) => c.kind === kind).map((c) => c.slot));
    return [...slots].map((s) => resolve(index, s, set, overrides, usable)).filter(Boolean);
  }

  // A cycle idle is playable when the postures it goes through are.
  function playable(index, c, set, overrides, usable) {
    if (!c) return false;
    if (c.file) return !usable || usable(c);
    if (c.cycle) return c.cycle.filter((s) => resolve(index, s, set, overrides, usable)).length >= 2;
    return false;
  }

  // "loaded" (everything in the index is there), "partial:<n missing>", "none".
  function status(index, loaded) {
    const files = Object.values((index && index.clips) || {}).filter((c) => c.file);
    if (!files.length) return 'none';
    const missing = files.filter((c) => !loaded.has(c.id)).length;
    return missing ? (missing === files.length ? 'none' : `partial:${missing}`) : 'loaded';
  }

  return { KINDS, SETS, MASKS, POSTURES, POSTURE_LABEL, parseId, validateManifest, cleanIndex, resolve, slotsOf, playable, status };
});
