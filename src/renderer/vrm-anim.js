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
//
// The rest clip (T-2829): REST_ID is a clip made here from the rest pose (arms down, renderer/vrm.js) that keys
// every kept bone. It is the base whenever the director asks for none (no idle clip: no motion library, or a
// slot it lacks) — so the base can always cross-fade *back* from a dance or a posture. Before it, a base
// asked to be "nothing" was skipped and the last clip (a dance on its frozen external clock) stayed on at
// weight 1 for good: the dance froze on its last frame and every later touch, meal or sleep only changed her
// face. A base clip now always leaves through a cross-fade to the next base, the rest clip included.
(function () {
  const LOOP_BLEND = 0.5;
  // phase alignment (T-5084): a new idle loop starts at the time of its clip whose pose is nearest to the pose she
  // shows now (ALIGN_N candidates, shifted by a random offset so the same idle never beats on the same clock), so a
  // cross-fade blends two similar poses instead of pulling her through a far one. Weights: the bones that show most.
  const ALIGN_N = 16;
  const ALIGN_W = { hips: 2, spine: 1, chest: 1, upperChest: 0.5, neck: 0.5, head: 0.7, leftUpperArm: 1.5, rightUpperArm: 1.5, leftLowerArm: 1, rightLowerArm: 1, leftUpperLeg: 1.5, rightUpperLeg: 1.5, leftLowerLeg: 1, rightLowerLeg: 1 };
  const REST_ID = 'rest.pose';
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

    // The rest clip from a pose: { bone: [x, y, z, w] } (normalized bones; a bone not named is identity). Two
    // equal keys a second apart (a constant clip, looped); the hips stay where they are now (the rest pose).
    function setRest(pose) {
      const tracks = [];
      for (const name of keep) {
        const n = nodeOf(name);
        if (!n) continue;
        const q = (pose && pose[name]) || [0, 0, 0, 1];
        tracks.push(new T.QuaternionKeyframeTrack(`${n.name}.quaternion`, [0, 1], [...q, ...q]));
      }
      if (hipsNode) { const p = hipsNode.position.toArray(); tracks.push(new T.VectorKeyframeTrack(`${hipsNode.name}.position`, [0, 1], [...p, ...p])); }
      const playing = layers.some((l) => l.id === REST_ID);
      if (playing) return false; // only before it plays (the pose does not change while a model is loaded)
      const old = clips.get(REST_ID);
      if (old) { const a = mixer.existingAction(old.clip); if (a) a.stop(); mixer.uncacheClip(old.clip); }
      add(REST_ID, new T.AnimationClip(REST_ID, 1, tracks));
      return true;
    }

    // The time in clip `id` whose pose is nearest the pose now (ALIGN above) → { time, dist, mean } (dist: the weighted
    // 1 − |q·q'| at that time, mean: over all candidates — how much the alignment saved)
    let lastAlign = null;
    function alignedTime(id, jitter = Math.random()) {
      const tracks = sampler(id);
      const c = clips.get(id);
      if (!tracks || !tracks.length || !c || !(c.clip.duration > 0.2)) return null;
      const dur = c.clip.duration;
      let best = 0;
      let bestD = Infinity;
      let sum = 0;
      for (let i = 0; i < ALIGN_N; i++) {
        const tt = ((i + jitter) / ALIGN_N) * dur;
        let d = 0;
        for (const tr of tracks) {
          const w = tr.q && ALIGN_W[tr.bone];
          if (!w) continue;
          qa.fromArray(tr.interp.evaluate(tt)).normalize();
          d += w * (1 - Math.abs(qa.dot(tr.node.quaternion)));
        }
        sum += d;
        if (d < bestD) { bestD = d; best = tt; }
      }
      lastAlign = { id, time: +best.toFixed(3), dist: +bestD.toFixed(5), mean: +(sum / ALIGN_N).toFixed(5), duration: +dur.toFixed(3) };
      return lastAlign;
    }

    // Cross-fade the base to clip `id` over `dur` seconds (0: at once). Unknown id → false. opts: { phase (0..1:
    // where in the clip a newly started action begins), align (start where the pose is nearest the pose now: the
    // phase alignment above, T-5084), speed (its time scale) } — idles use them so a loop never keeps the same beat.
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
        if (opts && opts.align) { const a = alignedTime(id); if (a) action.time = a.time; } else if (opts && opts.phase > 0) action.time = (opts.phase % 1) * c.clip.duration;
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

    // The director's base (plan.base: { id, dance }) on the layers. A dance clip not loaded yet: nothing (the
    // dance cues in only once its clip is here). Any other base without a clip — id null (no motion library, a
    // slot it lacks) or unknown — is the rest clip: before T-2829 nothing happened then, and whatever played last
    // (a dance's frozen last frame, a posture) stayed on at weight 1 for good. → the id now cross-fading in.
    function playBase(base, dur, opts = null) {
      if (!base) return null;
      if (base.dance) return clips.has(base.id) && setBase(base.id, dur, opts) ? base.id : null;
      if (base.id && clips.has(base.id) && setBase(base.id, dur, opts)) return base.id;
      return setBase(REST_ID, dur) ? REST_ID : null;
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
      setRest,
      playBase,
      // the base back to the rest clip (cross-faded like any base); false before setRest
      toRest: (dur = 0.4) => setBase(REST_ID, dur),
      REST_ID,
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
      lastAlign: () => lastAlign && { ...lastAlign },
      alignedTime,
      weightSum: () => layers.reduce((s, l) => s + l.w, 0),
      dispose: () => { mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene); layers = []; clips.clear(); },
    };
  }

  window.PetVrmAnim = { createAnimLayers, maskWeight, REST_ID };
})();
