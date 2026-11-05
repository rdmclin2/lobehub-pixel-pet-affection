#!/usr/bin/env node
'use strict';

// Builds the motion library index (T-5081, docs/vrm-motion-library.md §2–§4): src/core/vrm-motion-index.json, the
// metadata of every clip the bake (scripts/vrm-bake.js --v2) turns into a .vrma — id, source pack and path,
// category / group, style, duration, loop, mask, enter / exit posture and the bake parameters. No binaries.
//
//   node scripts/vrm-motion-select.js [--assets ~/vrm-assets] [--scan ~/vrm-assets/_scan] [--check]
//
// Inputs: inventory.json (the packs' files and lobe-vidol labels), <scan>/features.json (scripts/vrm-motion-scan.js),
// src/core/vrm-library.json (the hand-tuned clips the director already plays: kept as they are, plus their neutral
// copies) and REVIEW below (the MMD motions, named by hand). --check: exit 1 when the committed index differs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Rules = require('./lib/vrm-motion-rules');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'core', 'vrm-motion-index.json');
const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return out;
}

// The MMD motions (motions pack): the rules are not trusted on them (their names say more), every one used is named
// here with its group and the styles it suits. Anything in motions/ not listed is out.
// Dances whose choreography holds both arms out straight and level (the pose guard's T-pose shape) for a moment:
// the MMD ones checked against an independent MMD forward kinematics (vrm-pose-guard vmdArmCheck, < 4° apart),
// so it is the dance, not the retarget. maxS: the longest such run the guard measured, plus 0.3 s.
const ARMS_OUT = {
  'mx-c9c650df': { maxS: 0.6, why: 'Mixamo dance: arms swung out level on the beat' },
  'mx-c9c65b7c': { maxS: 0.5, why: 'Mixamo dance: arms swung out level on the beat' },
  'mx-c9c6ed9e': { maxS: 1.1, stiffS: 2.4, why: 'Mixamo dance: opens with both arms spread, and holds the spread 2 s on a beat at 13.3 s' },
  'vmd-g-i-dle-tomboy': { maxS: 2.0, why: 'TOMBOY: arms-spread figures (120 s, 168 s)' },
  'vmd-aoa-miniskirt-queendom-ver': { maxS: 0.7, why: 'Miniskirt: arms out to the side' },
  'vmd-brown-eyed-girls-abracadabra': { maxS: 0.7, why: 'Abracadabra: arms out level' },
  'vmd-everglow-bon-bon-chocolat-full-ver': { maxS: 0.6, why: 'Bon Bon Chocolat: arms out level' },
  'vmd-t-ara-bunny-style': { maxS: 0.6, why: 'Bunny Style: arms out level' },
  'vmd-t-ara-number-nine': { maxS: 0.9, why: 'Number Nine: arms out level' },
  'vmd-twice-like-ooh-ahh': { maxS: 0.6, why: 'Like OOH-AHH: arms out level' },
  'vmd-addiction': { maxS: 0.6, why: 'addiction: arms out level' },
  'vmd-galaxias': { maxS: 0.9, why: 'galaxias: arms out level' },
  'vmd-kiss-me-aishiteru': { maxS: 0.6, why: 'kiss me 愛してる: arms out level' },
  'vmd-magic-of-xyz': { maxS: 2.0, why: 'magic of xyz: arms held out (54 s)' },
  'vmd-qsx': { maxS: 0.9, why: 'qsx: arms out level' },
  'vmd-suki-yuki-maji-magic': { maxS: 1.0, why: 'suki yuki maji magic: arms held out in front' },
  'vidol-dance-gokuraku': { maxS: 0.6, why: '極楽浄土: arms out level' },
  'vidol-dance-last-surprise': { maxS: 2.0, why: 'Last Surprise: arms held out (77 s)' },
  'vidol-dance-shujiwu': { maxS: 1.8, why: '书记舞: arms stretched out in front (13 s)' },
};
// Reactions (by source) that throw the arms out on purpose: a jump's arm swing, a yawn's stretch
const ARMS_OUT_SRC = {
  'mixamo/c9c98361-b96c-11e4-a802-0aaa78deedf9.fbx': { maxS: 0.6, why: 'a yawn: both arms stretched out' },
};
// T-5098: sources too fast to draw at the 9–15 fps of a machine without a GPU — the renderer's jerk limit
// (core/vrm-bone-map.js limitAccel jMax, renderer/vrm.js loadVrma) would have to move a bone > 35° to keep their
// spike ≤ 10°/frame@30 (scripts/vrm-spike-scan.js), i.e. the clip would no longer be itself: out of the index,
// the next candidate by score takes the slot
const TOO_FAST = {
  'mixamo/0635e50a-9988-4d8e-9d85-1db01c9c342c.fbx': 'a wave flapping the hand at ~4 Hz (greet-01/02: 60° to cut)',
  'motions/tsuna/tsuna_small_jump.vmd': 'a hop kicking the lower legs (jump-01: 49° to cut)',
  'mixamo/c9c7a268-b96c-11e4-a802-0aaa78deedf9.fbx': 'a shy shake of the forearms (emote.shy-02@male: 38° to cut)',
  'mixamo/c9cd9927-b96c-11e4-a802-0aaa78deedf9.fbx': 'an excited shake of the hands (emote.excited-01: 35° to cut)',
};
// T-5098: not a rest pose — kneeling with both arms spread out, still (the pose guard's stiff-out check): crouch.v02@male
TOO_FAST['mixamo/ede8954e-5272-46c2-b3c5-c701e5ee887c.fbx'] = 'kneels with both arms spread out wide (crouch.v02@male: stiff arms out)';
// T-5099: base poses holding both upper arms above level (the pose guard's RAISED check; the runtime counts such a
// pose's samples as T-pose frames): "Sitting, Arms Raised" (sit.v03@female/@neutral, hands behind the head, 20 s still
// in the final retest), from both the mixamo and the postures pack
TOO_FAST['mixamo/e84e677b-c981-4333-8242-3ff820f8cf7f.fbx'] = 'sits with both arms raised behind the head (sit.v03: raised-arms base pose)';
TOO_FAST['postures/e84e677b-c981-4333-8242-3ff820f8cf7f.fbx'] = 'the same Sitting, Arms Raised in the postures pack';
// the longest a one-shot reaction / emotion plays (s); a longer source is trimmed to its busiest window
const REACT_MAX = 6;

const REVIEW = {
  'motions/tsuna/tsuna_standby.vmd': { group: 'idle', note: 'つな 待機 (standby loop)' },
  // T-5098: penguin_stand.vmd is out of the idle rotation — both arms held out ~50° to the side, still for its whole
  // 10 s (the pose guard's stiff-out check; T-5097 saw it as a coat-hanger stance on Vrchat Avatar). Its slot goes to
  // the next idle by score (every style keeps ≥ 6 idles).
  'motions/_TEMP/_motion_basic_pack01/standmix2_modified.vmd': { group: 'idle', trim: [7.4, 36.1], note: 'standmix2: a long mixed standing idle from 7.4 s (T-5092: 3.2–7.3 s is a stretch with both arms held level in front, read as a T-pose in an idle)' },
  'motions/_kiss_blush.vmd': { group: 'shy', gender: 'female', note: 'kiss blush: a shy lean in' },
  'motions/_kiss2_blush.vmd': { group: 'shy', gender: 'female', note: 'kiss blush 2' },
  'motions/cover_chest_v01.vmd': { group: 'shy', gender: 'female', note: 'covers her chest, embarrassed' },
  'motions/_TEMP/emote/happy1.vmd': { group: 'happy', note: 'happy emote' },
  'motions/talk/xs-talk8-west-negotiate.vmd': { group: 'talk', note: 'negotiating talk gestures' },
  'motions/casual/へなへなと座り込む_gumi.vmd': { group: 'sad', gender: 'female', note: 'へなへな座り込む: sinks to the floor (ends sitting)' },
  'motions/walk_n_run/walk_A01_f0-40_s9.85.vmd': { group: 'walk', note: 'walk cycle A01 (in place)' },
  'motions/walk_n_run/walk_A34_f0-42.vmd': { group: 'walk', note: 'walk cycle A34' },
  // T-5098: tsuna_small_jump.vmd is out (TOO_FAST below)
  'motions/hit/h01_何かにぶつかる小.vmd': { group: 'surprised', note: 'bumps into something: a flinch' },
};

// how many clips per style and group (the generated ones; the hand-tuned base clips come on top)
const QUOTA = { stand: 5, sit: 4, crouch: 3, lay: 3, idle: 8, talk: 6, walk: 3, run: 1, turn: 1, dance: 6, default: 3 };
// the label shown for a group (≤ 20 characters with its number)
const LABEL = {
  stand: '站姿', sit: '坐姿', crouch: '蹲姿', lay: '躺姿', idle: '待机', greet: '挥手问候', bow: '鞠躬', nod: '点头', shake: '摇头', think: '思考',
  stretch: '伸懒腰', yawn: '打哈欠', clap: '拍手', point: '指向', shrug: '耸肩', look: '张望', jump: '小跳', agree: '赞同', fidget: '小动作', hold: '持续动作',
  happy: '开心', angry: '生气', sad: '难过', surprised: '惊讶', shy: '害羞', excited: '兴奋', talk: '说话手势', walk: '行走', run: '小跑', turn: '转身', dance: '舞蹈',
};
// how a group plays over the rest of her (core/vrm-library.js MASKS): the head only, the upper body, or all of her
const MASK = { nod: 'head', shake: 'head', look: 'head', talk: 'upper', think: 'upper', point: 'upper', clap: 'upper', greet: 'upper', shrug: 'upper', fidget: 'upper', agree: 'upper' };
const maskOf = (category, group) => (category === 'posture' || category === 'idle' || category === 'walk' ? 'full' : MASK[group] || 'full');
// slot names: the director's own slots stay as in vrm-library.json; generated ones are numbered within their group
function slotOf(category, group, n) {
  const nn = String(n).padStart(2, '0');
  if (category === 'posture') return `${group}.v${nn}`;
  if (category === 'idle') return `idle.v${nn}`;
  if (category === 'talk') return `hold.talk-g${nn}`;
  if (category === 'walk') return group === 'turn' ? `react.turn-${nn}` : `hold.${group}-${nn}`;
  if (category === 'emotion') return `emote.${group}-${nn}`;
  if (category === 'dance') return `dance.v${nn}`;
  return `react.${group}-${nn}`;
}
const kindOf = (category, group) => (category === 'posture' ? 'posture' : category === 'idle' ? 'idle' : category === 'dance' ? 'dance' : (category === 'talk' || category === 'walk') && group !== 'turn' ? 'hold' : 'reaction');
// a loop: idles, walks, talk gestures and dances; reactions play once
const loopOf = (category, group) => category === 'idle' || category === 'talk' || category === 'dance' || (category === 'walk' && group !== 'turn');

// the base clips (vrm-library.json): their category / group for the index
function baseGroup(slot) {
  if (/^stand\./.test(slot)) return ['posture', 'stand'];
  if (/^sit\./.test(slot)) return ['posture', 'sit'];
  if (/^idle\./.test(slot)) return ['idle', 'idle'];
  if (slot === 'hold.walk') return ['walk', 'walk'];
  if (/^hold\.talk/.test(slot)) return ['talk', 'talk'];
  if (/^hold\./.test(slot)) return ['reaction', 'hold'];
  const emo = { 'react.shy': 'shy', 'react.angry': 'angry', 'react.annoyed': 'angry', 'react.cheer': 'excited' };
  if (emo[slot]) return ['emotion', emo[slot]];
  if (slot === 'react.greet') return ['reaction', 'greet'];
  return ['reaction', 'fidget'];
}

function build({ assets, scan }) {
  const inv = JSON.parse(fs.readFileSync(path.join(assets, 'inventory.json'), 'utf8'));
  const feats = JSON.parse(fs.readFileSync(path.join(scan, 'features.json'), 'utf8')).clips;
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-library.json'), 'utf8'));
  const files = new Map();
  for (const pk of ['postures', 'mixamo', 'motions']) for (const f of inv.packs[pk].files) files.set(f.path, f);
  const clips = {};
  // 1. the hand-tuned base clips, and a neutral copy of each female one (neutral had none: T-5079 R4)
  for (const [id, e] of Object.entries(base.clips)) {
    const [slot, style] = id.split('@');
    const [category, group] = baseGroup(slot);
    const f = e.src ? feats[e.src] : null;
    const entry = { ...e, category, group, pack: e.src ? e.src.split('/')[0] : null, srcStyle: style, by: 'base', ...(f && !f.error ? { duration: f.duration, enter: f.start, exit: f.end } : {}) };
    delete entry.note;
    // every entry carries the same fields: a cycle (idle.posture-cycle) lasts its postures × every seconds, standing
    if (entry.loop === undefined) entry.loop = category === 'idle' || category === 'talk' || category === 'walk';
    if (entry.mask === undefined) entry.mask = 'full';
    if (e.cycle) Object.assign(entry, { pack: null, duration: e.cycle.length * e.every, enter: 'stand', exit: 'stand' });
    if (entry.enter === undefined && f && !f.error) Object.assign(entry, { enter: f.start, exit: f.end });
    clips[id] = entry;
    if (style === 'female') {
      const n = { ...entry, style: 'neutral', by: 'base-neutral' };
      if (n.cycle) n.cycle = e.cycle;
      clips[`${slot}@neutral`] = n;
    }
  }
  const baseSrc = new Set(Object.values(base.clips).map((e) => e.src).filter(Boolean));
  // 2. every candidate, classified
  const cands = [];
  const seen = new Set();
  for (const [src, f] of Object.entries(feats)) {
    if (f.error || baseSrc.has(src)) continue;
    const pack = src.split('/')[0];
    const inf = files.get(src) || {};
    const review = REVIEW[src] || null;
    if (pack === 'motions' && !review) continue;
    if (TOO_FAST[src]) continue;
    // a _TEMP copy of a motion that is also outside _TEMP: the same clip twice
    const key = `${pack}:${path.basename(src)}:${f.duration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = `${inf.use_this_phase || ''} ${(inf.style_tags || []).join(' ')}`;
    // the postures pack names part of its files "Male Sitting Pose (3).fbx": the same label as lobe-vidol's
    if (!inf.ref) { const m = /^(Male|Female) (Standing|Sitting|Crouch|Laying|Action|Dynamic|Locomotion|Dance) Pose/.exec(path.basename(src)); if (m) inf.ref = { type: 'Posture', gender: m[1], category: m[2], description: path.basename(src, '.fbx') }; }
    const c = Rules.classify(src, f, { ref: inf.ref || null, review, text });
    if (!c) continue;
    // the inventory's "NO" (adult-only, helpers, long stage shows) — but its "dances are not used this phase" is
    // exactly what this index lifts (dances go into the dance library)
    if (!review && c.category !== 'dance' && /^NO/.test(inf.use_this_phase || '')) continue;
    if (c.category === 'posture' && !f.static) continue; // a posture is a held pose
    if (c.category !== 'posture' && f.static) continue;
    // an idle starts and ends standing (the director plays idles between standing postures)
    if (c.category === 'idle' && (f.start !== 'stand' || f.end !== 'stand')) continue;
    const gender = review && review.gender ? review.gender : inf.ref ? inf.ref.gender : null;
    cands.push({ src, f, ...c, pack, gender: gender ? gender.toLowerCase() : null, styles: Rules.stylesOf(inf.ref, review && review.gender), review, label: inf.ref ? inf.ref.description : review ? review.note : null });
  }
  // 3. per style and group: the gendered sources of that style first, then the best scores
  const dances = {};
  const counters = {};
  for (const style of ['female', 'male', 'neutral']) {
    const groups = {};
    for (const c of cands) if (c.styles.includes(style)) (groups[c.group] = groups[c.group] || []).push(c);
    for (const [group, list] of Object.entries(groups).sort()) {
      list.sort((a, b) => (b.gender === style) - (a.gender === style) || b.score - a.score || a.src.localeCompare(b.src));
      const quota = QUOTA[group] || QUOTA.default;
      for (const c of list.slice(0, quota)) {
        const category = c.category;
        const k = `${style}:${category}:${group}`;
        counters[k] = (counters[k] || 0) + 1;
        const slot = slotOf(category, group, counters[k]);
        const entry = {
          kind: kindOf(category, group), category, group, style, pack: c.pack, src: c.src,
          label: `${LABEL[group] || group}${counters[k]}`, duration: c.f.duration, loop: loopOf(category, group), mask: maskOf(category, group),
          enter: c.f.start, exit: c.f.end, srcStyle: c.gender || 'unlabelled', by: c.by, score: c.score,
          ...(c.label ? { about: String(c.label).slice(0, 80) } : {}),
          ...(c.review && c.review.trim ? { trim: c.review.trim } : {}),
          ...(category === 'walk' && group !== 'turn' ? { detrend: true } : {}),
          ...(category !== 'posture' && group !== 'turn' ? { faceFront: true } : {}),
          ...(category === 'posture' && group === 'sit' && c.f.hips.heightMean > 0.4 ? { sit: true } : {}),
        };
        if (entry.kind === 'reaction' || entry.kind === 'hold') Object.assign(entry, { fadeIn: 0.3, fadeOut: 0.5, weight: 1 });
        if (category === 'dance') {
          // one dance-library entry per source (src/main/vrm-dances.js), tagged with every style it serves
          const id = `mx-${path.basename(c.src, '.fbx').slice(0, 8)}`;
          const d = dances[id] || (dances[id] = { kind: 'dance', category, group, pack: c.pack, src: c.src, name: String(c.label || id).replace(/^Female /, '').slice(0, 40), duration: c.f.duration, loop: true, mask: 'full', enter: c.f.start, exit: c.f.end, srcStyle: entry.srcStyle, by: c.by, styles: [] });
          d.styles.push(style);
          counters[k]--;
          continue;
        }
        clips[`${slot}@${style}`] = entry;
      }
    }
  }
  // 4. the MMD dances (dances pack): one per folder, its motion VMD with the most bone keys (camera / prop motions
  // and the stage chair skipped); baked into the dance library with its music (scripts/vrm-bake.js bakeDance)
  const byFolder = {};
  for (const f of inv.packs.dances.files) {
    if (!/\.vmd$/i.test(f.path) || !(f.bone_keys > 100)) continue;
    const folder = f.path.split('/').slice(0, 2).join('/'); // one dance per top folder
    if (!byFolder[folder] || f.bone_keys > byFolder[folder].bone_keys) byFolder[folder] = f;
  }
  for (const [folder, f] of Object.entries(byFolder).sort()) {
    const slug = path.basename(folder).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `d${Object.keys(dances).length}`;
    const id = slug.startsWith('vidol-dance-') ? slug : `vmd-${slug}`.slice(0, 48);
    dances[id] = { kind: 'dance', category: 'dance', group: 'dance', pack: 'dances', src: f.path, folder: path.dirname(f.path), name: path.basename(folder).slice(0, 40), duration: f.duration_s, loop: false, mask: 'full', enter: 'stand', exit: 'stand', srcStyle: 'unlabelled', by: 'folder', styles: ['female', 'male', 'neutral'] };
  }
  // 4b. dance figures that hold both arms out straight on purpose (T-5092 pose guard, scripts/lib/vrm-pose-guard.js):
  // `armsOut` lets the guard pass a level-arm run up to maxS seconds — a longer one (a broken retarget) still fails
  for (const [id, a] of Object.entries(ARMS_OUT)) if (dances[id]) dances[id].armsOut = a;
  for (const e of Object.values(clips)) if (e.src && ARMS_OUT_SRC[e.src]) e.armsOut = ARMS_OUT_SRC[e.src];
  // 5. a one-shot reaction / emotion longer than REACT_MAX plays only its busiest REACT_MAX seconds (some rule-picked
  // Mixamo takes are 20+ s of nodding or fidgeting); `duration` is what plays (after trim), `srcDuration` the source
  for (const e of Object.values(clips)) {
    if (!e.trim && !e.loop && (e.category === 'reaction' || e.category === 'emotion') && e.duration > REACT_MAX) {
      const f = e.src ? feats[e.src] : null;
      const peak = f && f.burst ? f.burst.at * e.duration : 0;
      const t0 = Math.max(0, Math.min(e.duration - REACT_MAX, peak - REACT_MAX / 3));
      e.trim = [+t0.toFixed(2), +(t0 + REACT_MAX).toFixed(2)];
      e.autoTrim = true;
    }
    if (Array.isArray(e.trim) && e.duration > 0) {
      e.srcDuration = e.duration;
      e.duration = +(Math.min(e.trim[1], e.duration) - e.trim[0]).toFixed(3);
    }
    // a pose (posture, a hold: true / still clip) is baked as one held second (vrm-bake-core bakeParams holdClip)
    if (e.src && (e.kind === 'posture' || e.hold === true || e.still)) {
      if (e.srcDuration === undefined) e.srcDuration = e.duration;
      e.duration = 1;
    }
  }
  return {
    schema: 2,
    about: 'VRM motion library index (T-5081, docs/vrm-motion-library.md). Metadata only — no model, animation or audio is in the repository; every src is a path under $PIXELPET_VRM_ASSETS (default ~/vrm-assets, personal use only). Generated by scripts/vrm-motion-select.js; baked by `node scripts/vrm-bake.js --v2`.',
    styleFallback: Rules.STYLE_FALLBACK,
    categories: Rules.CATEGORIES,
    clips,
    dances,
  };
}

// counts per style and category (the report and the tests)
function countsOf(index) {
  const out = {};
  const add = (style, category) => { out[style] = out[style] || {}; out[style][category] = (out[style][category] || 0) + 1; };
  for (const e of Object.values(index.clips)) add(e.style, e.category);
  for (const e of Object.values(index.dances || {})) for (const s of e.styles) add(s, 'dance');
  return out;
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  const assets = path.resolve(home(a.assets || process.env.PIXELPET_VRM_ASSETS || '~/vrm-assets'));
  const scan = path.resolve(home(a.scan || path.join(assets, '_scan')));
  const index = build({ assets, scan });
  const text = `${JSON.stringify(index, null, 2)}\n`;
  if (a.check) {
    const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (now !== text) { console.error('src/core/vrm-motion-index.json is stale: run node scripts/vrm-motion-select.js'); process.exit(1); }
    console.log('src/core/vrm-motion-index.json is up to date');
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(index.clips).length} clips, ${Object.keys(index.dances).length} dance entries`);
  }
  console.log(JSON.stringify(countsOf(index)));
}
module.exports = { build, countsOf, ARMS_OUT, ARMS_OUT_SRC, REVIEW, QUOTA, LABEL, slotOf, kindOf, loopOf, maskOf, baseGroup };
