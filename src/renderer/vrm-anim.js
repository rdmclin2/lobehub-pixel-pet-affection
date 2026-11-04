'use strict';
// The clip layers of a VRM figure (docs/vrm-motion-system.md §3.1): three's AnimationMixer playing the
// library's .vrma clips on the normalized humanoid. This release has the base layer (L0 posture / L1 idle,
// full body): one clip at a time, a new one cross-faded in over the director's fade.
//
// No T-pose, ever: three's PropertyMixer mixes whatever weight is missing below 1 with the bone's original
// (the T-pose), so during a cross-fade the weights always add up to exactly 1 (the new clip k, the old ones
// share 1 − k), every baked clip keys every bone (scripts/vrm-bake.js), and the first clip comes in at full
// weight at once. The alive layer's bones keep the clip's pose from frame to frame (PetVrmMotion.overClip):
// the mixer only writes a bone whose value changed, so a held pose would otherwise keep last frame's offsets
// and drift.
//
// Overlays (L2 holds, L3 reactions, docs §3.1 / §3.3): the director gives, every frame, a list of clips with
// the time in the clip and a weight. They are not mixer actions — the PropertyMixer would average a masked
// upper-body clip with the T-pose below — but sampled here and laid over the base pose bone by bone
// (slerp from the base towards the clip by weight × the mask's weight for that bone). The base keeps
// playing at full weight underneath, so whatever the overlays do, a bone they leave is the base pose, never
// the T-pose, and an interrupted reaction simply loses weight. Every bone an overlay may move is kept in
// the over-clip memo too (rotations, and the hips position), so nothing they write stays behind.
//
// The dance layer (docs/vrm-dance.md §3.1, §4.1) is a base clip on an external clock: setBase(id, fade,
// { clock: 'external' }) starts it frozen (timeScale 0) and seekBase(t) sets its time every frame from the
// music, so it never drifts from it whatever the frame rate. A jump back (the dance looping) is not a snap:
// the frame it left keeps showing on a second action of the same clip (three keys clipAction by clip + root,
// so a clone of the clip) and fades into the new time over LOOP_BLEND s, the weights still summing to 1.
(function () {
  const LOOP_BLEND = 0.5;
  const smooth = (k) => { const x = Math.max(0, Math.min(1, k)); return x * x * (3 - 2 * x); };

  // how much of an overlay each bone takes, per mask (soft at the waist so an upper-body clip bends in)
  const ARM_BONES = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Thumb', 'Index', 'Middle', 'Ring', 'Little'];
  function maskWeight(mask, bone) {
    if (mask === 'full') return 1;
    const arm = ARM_BONES.some((a) => bone.includes(a));
    if (mask === 'arms') return arm ? (bone.endsWith('Shoulder') ? 0.7 : 1) : 0;
    if (mask === 'head') return bone === 'head' ? 1 : bone === 'neck' ? 0.6 : 0;
    // upper
    if (bone === 'hips' || /Leg$|Foot$|Toes$/.test(bone)) return 0;
    if (bone === 'spine') return 0.5;
    if (bone === 'chest') return 0.8;
    return 1;
  }

  // R: the runtime (window.PetVrmRuntime), vrm: the loaded VRM, keep: bone names the alive layer moves
  function createAnimLayers(R, vrm, keepLife) {
    const T = R.THREE;
    // every humanoid bone the model has: overlays may move any of them
    const boneNames = vrm.humanoid ? Object.keys(vrm.humanoid.humanBones || {}).filter((n) => vrm.humanoid.getNormalizedBoneNode(n)) : [];
    const keep = [...new Set([...(keepLife || []), ...boneNames])];
    const hipsNode = vrm.humanoid ? vrm.humanoid.getNormalizedBoneNode('hips') : null;
    let hipsMemo = null;
    const sampled = new Map(); // clip id → [{ node, bone, q, interp }]
    const qa = new T.Quaternion();
    const va = new T.Vector3();
    const mixer = new T.AnimationMixer(vrm.scene);
    const clips = new Map(); // id → { clip, fingers }
    let layers = []; // { id, action, w0 (weight when the fade began), w }
    let fade = { from: 0, dur: 0, to: null };
    let t = 0;
    const memo = new Map();
    const nodeOf = (name) => (vrm.humanoid ? vrm.humanoid.getNormalizedBoneNode(name) : null);

    // a clip's tracks as interpolants on the normalized bones (for overlays)
    function sampler(id) {
      if (sampled.has(id)) return sampled.get(id);
      const c = clips.get(id);
      if (!c) return null;
      const byNode = new Map(boneNames.map((b) => [vrm.humanoid.getNormalizedBoneNode(b).name, b]));
      const list = [];
      for (const tr of c.clip.tracks) {
        const [nodeName, prop] = tr.name.split('.');
        const bone = byNode.get(nodeName);
        if (!bone || (prop !== 'quaternion' && !(prop === 'position' && bone === 'hips'))) continue;
        list.push({ node: vrm.humanoid.getNormalizedBoneNode(bone), bone, q: prop === 'quaternion', interp: tr.createInterpolant(), duration: c.clip.duration });
      }
      sampled.set(id, list);
      return list;
    }

    // lay the overlays over the pose the mixer (and memo) left: [{ id, time, weight, mask }]
    let lastOverlays = '';
    function applyOverlays(list) {
      const shown = [];
      for (const o of list || []) {
        if (!(o.weight > 0.0005)) continue;
        const tracks = sampler(o.id);
        if (!tracks) continue;
        shown.push(`${o.layer || 'overlay'}:${o.id}:${o.weight.toFixed(2)}`);
        for (const tr of tracks) {
          const k = o.weight * maskWeight(o.mask || 'upper', tr.bone);
          if (!(k > 0)) continue;
          const v = tr.interp.evaluate(Math.max(0, Math.min(tr.duration, o.time || 0)));
          if (tr.q) { qa.fromArray(v).normalize(); tr.node.quaternion.slerp(qa, Math.min(1, k)); } else if (o.mask === 'full') tr.node.position.lerp(va.fromArray(v), Math.min(1, k));
        }
      }
      lastOverlays = shown.join(',');
    }

    function add(id, clip) {
      sampled.delete(id);
      const names = new Set(clip.tracks.map((tr) => tr.name.split('.')[0]));
      const finger = nodeOf('leftIndexProximal');
      clips.set(id, { clip, fingers: !!(finger && names.has(finger.name)) });
    }

    // Cross-fade the base to clip `id` over `dur` seconds (0: at once). Unknown id → false. opts: { phase (0..1:
    // where in the clip a newly started action begins), speed (its time scale) } — idles use them so a loop
    // never keeps the same beat.
    function setBase(id, dur = 1, opts = null) {
      const c = clips.get(id);
      if (!c) return false;
      if (fade.to && fade.to.id === id) return true;
      let L = layers.find((l) => l.id === id);
      const external = !!(opts && opts.clock === 'external');
      if (!L) {
        const action = mixer.clipAction(c.clip);
        action.setLoop(T.LoopRepeat, Infinity);
        action.reset().play();
        if (opts && opts.phase > 0) action.time = (opts.phase % 1) * c.clip.duration;
        if (opts && opts.speed > 0) action.timeScale = opts.speed;
        L = { id, action, w: 0, external, duration: c.clip.duration };
        layers.push(L);
      }
      if (external) { L.external = true; L.action.timeScale = 0; L.action.time = clampT(L, (opts && opts.time) || 0); }
      if (!(dur > 0) || layers.length === 1) {
        for (const l of layers) if (l !== L) l.action.stop();
        layers = [L];
        L.w = 1;
        L.action.setEffectiveWeight(1);
        fade = { from: t, dur: 0, to: L };
        return true;
      }
      for (const l of layers) l.w0 = l.w;
      fade = { from: t, dur, to: L };
      return true;
    }

    const clampT = (L, t) => Math.max(0, Math.min(Math.max(0, L.duration - 1e-3), Number(t) || 0));
    // The external clock (a dance): the time in the base clip now. opts.blend (the dance came round, a loop):
    // the old frame stays on a twin action and fades into the new one (LOOP_BLEND); any other jump is a cut.
    function seekBase(t, opts = null) {
      const L = fade.to;
      if (!L || !L.external) return false;
      const want = clampT(L, t);
      if (opts && opts.blend && want < L.action.time - 0.5) {
        const c = clips.get(L.id);
        if (!c.twin) c.twin = c.clip.clone();
        const clip = L.action.getClip() === c.clip ? c.twin : c.clip;
        const action = mixer.clipAction(clip);
        action.setLoop(T.LoopRepeat, Infinity);
        action.reset().play();
        action.timeScale = 0;
        action.time = want;
        const N = { id: L.id, action, w: 0, external: true, duration: L.duration };
        layers.push(N);
        for (const l of layers) l.w0 = l.w;
        fade = { from: t0(), dur: LOOP_BLEND, to: N };
        return true;
      }
      L.action.time = want;
      return true;
    }
    const t0 = () => t;
    // Let a clip go (a dance some time after it stopped): its actions, the mixer's cache, the overlay sampler.
    function remove(id) {
      const c = clips.get(id);
      if (!c || layers.some((l) => l.id === id)) return false;
      for (const clip of [c.clip, c.twin].filter(Boolean)) { const a = mixer.existingAction(clip); if (a) a.stop(); mixer.uncacheAction(clip); mixer.uncacheClip(clip); }
      clips.delete(id);
      sampled.delete(id);
      return true;
    }

    // One frame: the weights of the fade (always summing to 1), then the mixer under the kept bones' memo,
    // then the overlays (holds, reactions) over it.
    function update(dt, overlays) {
      t += dt;
      if (fade.to && layers.length > 1) {
        const k = fade.dur > 0 ? smooth((t - fade.from) / fade.dur) : 1;
        const others = layers.filter((l) => l !== fade.to);
        const sum0 = others.reduce((s, l) => s + (l.w0 || 0), 0) || 1;
        fade.to.w = k + (1 - k) * (fade.to.w0 || 0);
        for (const l of others) l.w = (1 - fade.to.w) * ((l.w0 || 0) / sum0);
        if (k >= 1) {
          for (const l of others) l.action.stop();
          layers = [fade.to];
          fade.to.w = 1;
        }
      }
      for (const l of layers) l.action.setEffectiveWeight(l.w);
      if (!layers.length) { lastOverlays = ''; return false; }
      if (hipsNode && hipsMemo) hipsNode.position.copy(hipsMemo);
      window.PetVrmMotion.overClip(memo, nodeOf, keep, mixer, dt);
      if (hipsNode) { if (hipsMemo) hipsMemo.copy(hipsNode.position); else hipsMemo = hipsNode.position.clone(); }
      applyOverlays(overlays);
      return true;
    }

    return {
      add,
      has: (id) => clips.has(id),
      setBase,
      seekBase,
      remove,
      // the time the base clip shows now (a dance: what seekBase set)
      baseTime: () => (fade.to ? fade.to.action.time : null),
      external: () => !!(fade.to && fade.to.external),
      update,
      fingers: () => { const top = fade.to && clips.get(fade.to.id); return !!(top && top.fingers); },
      current: () => (fade.to ? fade.to.id : null),
      fading: () => layers.length > 1,
      // "id:weight" of every playing clip, for data-layers
      summary: () => layers.map((l) => `${l.id}:${l.w.toFixed(2)}`).join(','),
      overlays: () => lastOverlays,
      weightSum: () => layers.reduce((s, l) => s + l.w, 0),
      dispose: () => { mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene); layers = []; clips.clear(); },
    };
  }

  window.PetVrmAnim = { createAnimLayers, maskWeight };
})();
