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
(function () {
  const smooth = (k) => { const x = Math.max(0, Math.min(1, k)); return x * x * (3 - 2 * x); };

  // R: the runtime (window.PetVrmRuntime), vrm: the loaded VRM, keep: bone names the alive layer moves
  function createAnimLayers(R, vrm, keep) {
    const T = R.THREE;
    const mixer = new T.AnimationMixer(vrm.scene);
    const clips = new Map(); // id → { clip, fingers }
    let layers = []; // { id, action, w0 (weight when the fade began), w }
    let fade = { from: 0, dur: 0, to: null };
    let t = 0;
    const memo = new Map();
    const nodeOf = (name) => (vrm.humanoid ? vrm.humanoid.getNormalizedBoneNode(name) : null);

    function add(id, clip) {
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

    // One frame: the weights of the fade (always summing to 1), then the mixer under the kept bones' memo.
    function update(dt) {
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
      if (!layers.length) return false;
      window.PetVrmMotion.overClip(memo, nodeOf, keep, mixer, dt);
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
      weightSum: () => layers.reduce((s, l) => s + l.w, 0),
      dispose: () => { mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene); layers = []; clips.clear(); },
    };
  }

  window.PetVrmAnim = { createAnimLayers };
})();
