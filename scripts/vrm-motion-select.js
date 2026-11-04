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
const REVIEW = {
  'motions/tsuna/tsuna_standby.vmd': { group: 'idle', note: 'つな 待機 (standby loop)' },
  'motions/penguin_stand.vmd': { group: 'idle', note: 'penguin stand: a calm standing idle' },
  'motions/_TEMP/_motion_basic_pack01/standmix2_modified.vmd': { group: 'idle', trim: [0, 20], note: 'standmix2: a long mixed standing idle, first 20 s' },
  'motions/_kiss_blush.vmd': { group: 'shy', gender: 'female', note: 'kiss blush: a shy lean in' },
  'motions/_kiss2_blush.vmd': { group: 'shy', gender: 'female', note: 'kiss blush 2' },
  'motions/cover_chest_v01.vmd': { group: 'shy', gender: 'female', note: 'covers her chest, embarrassed' },
  'motions/_TEMP/emote/happy1.vmd': { group: 'happy', note: 'happy emote' },
  'motions/talk/xs-talk8-west-negotiate.vmd': { group: 'talk', note: 'negotiating talk gestures' },
  'motions/casual/へなへなと座り込む_gumi.vmd': { group: 'sad', gender: 'female', note: 'へなへな座り込む: sinks to the floor (ends sitting)' },
  'motions/walk_n_run/walk_A01_f0-40_s9.85.vmd': { group: 'walk', note: 'walk cycle A01 (in place)' },
  'motions/walk_n_run/walk_A34_f0-42.vmd': { group: 'walk', note: 'walk cycle A34' },
  'motions/tsuna/tsuna_small_jump.vmd': { group: 'jump', note: 'small hop' },
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
module.exports = { build, countsOf, REVIEW, QUOTA, LABEL, slotOf, kindOf, loopOf, maskOf, baseGroup };
