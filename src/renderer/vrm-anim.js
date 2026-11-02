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
(function () {
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

    // Cross-fade the base to clip `id` over `dur` seconds (0: at once). Unknown id → false.
    function setBase(id, dur = 1) {
      const c = clips.get(id);
      if (!c) return false;
      if (fade.to && fade.to.id === id) return true;
      let L = layers.find((l) => l.id === id);
      if (!L) {
        const action = mixer.clipAction(c.clip);
        action.setLoop(T.LoopRepeat, Infinity);
        action.reset().play();
        L = { id, action, w: 0 };
        layers.push(L);
      }
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
