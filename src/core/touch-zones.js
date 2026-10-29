'use strict';

// Touching the pet (触摸): which body part a click landed on, how she reacts to it, and what she says.
// Pure and Electron-free; every function takes what it needs explicitly so it is trivially testable.
//
// Hit testing works on the sprite's visible box (the bounding box of its opaque pixels), with the
// click point normalised to x, y ∈ [0, 1] (0, 0 = top left). Every built-in model-chan stands facing
// front with her hands folded in front of her, so one default table fits them all; a character file
// (`touch.zones` in src/characters/<id>.json) may add or replace zones where her art differs, e.g. a
// tail. Zones are rectangles [x0, y0, x1, y1] (inclusive), tried in ZONE_ORDER; the first hit wins.
//
// Content boundary (docs/affection-design.md 8.2): touching the chest or hips is a boundary she
// keeps. Strangers get told off (and lose affection); friends get a flustered "hey"; only at the
// highest stages is it a shy, forgiving reaction. Nothing explicit, for any character or setting.

// Loaded lazily: species.js validates `touch` blocks while affection.js is still loading species.js.
const aff = () => require('./affection');

const ZONE_IDS = ['head', 'face', 'chest', 'hands', 'belly', 'butt', 'legs', 'feet', 'tail'];
const REQUIRED_ZONES = ['head', 'chest', 'butt', 'feet', 'hands'];

// `sensitivity`: 0 = fine to touch, 1 = a little personal (shy until you are close),
// 2 = a boundary (told off while you are not close). `mood` is the reaction when all is well.
const ZONES = {
  head: { label: '头', sensitivity: 0, mood: 'happy' },
  face: { label: '脸', sensitivity: 0, mood: 'happy' },
  chest: { label: '胸', sensitivity: 2, mood: 'shy' },
  hands: { label: '手', sensitivity: 0, mood: 'happy' },
  belly: { label: '肚子', sensitivity: 0, mood: 'ticklish' },
  butt: { label: '臀', sensitivity: 2, mood: 'shy' },
  legs: { label: '腿', sensitivity: 1, mood: 'shy' },
  feet: { label: '脚', sensitivity: 0, mood: 'ticklish' },
  tail: { label: '尾巴', sensitivity: 1, mood: 'ticklish' },
};

// Default zone table for a front-facing standing sprite, measured on the five built-in pixel packs
// (visible box ≈ 65×180 px: hair top 0, chin ≈ 0.18, folded hands 0.36–0.47, hem ≈ 0.85, shoes below).
const DEFAULT_ZONES = {
  face: [[0.3, 0.07, 0.7, 0.18]],
  head: [[0.1, 0, 0.9, 0.19]],
  hands: [[0.28, 0.36, 0.72, 0.47], [0, 0.28, 0.22, 0.52], [0.78, 0.28, 1, 0.52]],
  chest: [[0.18, 0.19, 0.82, 0.34]],
  belly: [[0.22, 0.34, 0.78, 0.46]],
  butt: [[0.08, 0.46, 0.92, 0.6]],
  legs: [[0.02, 0.6, 0.98, 0.86]],
  feet: [[0.15, 0.86, 0.85, 1]],
};
// Tried first to last; zones a character adds that are not listed here go first (they are the
// special parts of her art, e.g. a tail sticking out beside the arms).
const ZONE_ORDER = ['face', 'tail', 'hands', 'head', 'chest', 'belly', 'butt', 'legs', 'feet'];

const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every((v) => typeof v === 'number' && v >= 0 && v <= 1) && r[0] <= r[2] && r[1] <= r[3];

// Problems with a character's `touch` block (empty = valid). Used by species.validateCharacter.
function validateTouch(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['touch must be an object'];
  const checkZones = (zones, where) => {
    if (!zones || typeof zones !== 'object') return errors.push(`${where} must map zone ids to rectangles`);
    for (const [id, rects] of Object.entries(zones)) {
      if (!ZONE_IDS.includes(id)) errors.push(`${where}.${id} is not a zone (${ZONE_IDS.join(', ')})`);
      else if (!Array.isArray(rects) || !rects.every(isRect)) errors.push(`${where}.${id} must be a list of [x0, y0, x1, y1] in 0..1`);
    }
  };
  if (t.zones !== undefined) checkZones(t.zones, 'touch.zones');
  if (t.poses !== undefined) for (const [pose, zones] of Object.entries(t.poses || {})) checkZones(zones, `touch.poses.${pose}`);
  if (t.lines !== undefined) {
    const lines = t.lines;
    if (!lines || typeof lines !== 'object') errors.push('touch.lines must be an object');
    else {
      const strs = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim());
      for (const [k, v] of Object.entries(lines)) {
        if (k === 'streak') {
          for (const m of ['annoyed', 'angry']) if (!strs(v && v[m])) errors.push(`touch.lines.streak.${m} needs at least one line`);
        } else if (!ZONE_IDS.includes(k)) errors.push(`touch.lines.${k} is not a zone`);
        else for (const tier of TIERS) if (!strs(v && v[tier])) errors.push(`touch.lines.${k}.${tier} needs at least one line`);
      }
    }
  }
  return errors;
}

// The zone table for a character (a species object or its `touch` block) and pose.
function zonesFor(character, pose) {
  const t = (character && (character.touch || character)) || {};
  const own = { ...(t.zones || {}), ...((pose && t.poses && t.poses[pose]) || {}) };
  const zones = { ...DEFAULT_ZONES, ...own };
  const extra = Object.keys(own).filter((id) => !ZONE_ORDER.includes(id));
  return [...extra, ...ZONE_ORDER].filter((id) => zones[id] && zones[id].length).map((id) => ({ id, rects: zones[id] }));
}

// The body part at (x, y) in the sprite's visible box, or null: outside the box, on a transparent
// pixel (`opaque: false`, as sampled by the caller), or on a spot no zone covers.
function zoneAt(x, y, { character = null, pose = null, opaque = true } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (opaque === false) return null;
  for (const z of zonesFor(character, pose)) {
    if (z.rects.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) return z.id;
  }
  return null;
}

// ---- reactions ------------------------------------------------------------------------------
// Relationship stages grouped for touch: strangers / acquaintances, close friends, and the top two.
const TIERS = ['low', 'mid', 'high'];
function tierFor(relStage) {
  const i = aff().stageIndex(relStage);
  return i >= 3 ? 'high' : i === 2 ? 'mid' : 'low';
}

// Poking the same part again within STREAK.windowMs counts as one streak.
const STREAK = { windowMs: 8000, annoyedAt: 3, angryAt: 6 };

// The streak after a touch on `zone` at `now`, given the previous one (pet.touchStreak).
function nextStreak(prev, zone, now) {
  if (prev && prev.zone === zone && now >= prev.at && now - prev.at <= STREAK.windowMs) return { zone, count: prev.count + 1, at: now };
  return { zone, count: 1, at: now };
}

// Animation per mood: a touch-<mood> clip if the art has one, else an existing fx state (core/fx.js).
const MOOD_FX = { happy: 'pat', ticklish: 'play', shy: 'happy', annoyed: 'sad', angry: 'sad' };
// Mood change per reaction (pet.mood 0..100).
const MOOD_DELTA = { happy: 6, ticklish: 5, shy: 2, annoyed: -3, angry: -8 };

// How she reacts to a touch on `zone` with the relationship at `relStage`, the `count`-th time in a
// row. { zone, mood, tier, streak, source, anim, fallback, moodDelta }:
// - `source` is the affection rule to score (core/affection.js), or null for no change;
// - `anim` is the zone's own touch clip ('touch-head'), `fallback` the fx state shown without one.
function reactionFor(zone, relStage, count = 1) {
  const z = ZONES[zone];
  if (!z) throw new Error(`Unknown touch zone: ${zone}`);
  const tier = tierFor(relStage);
  let mood = z.mood;
  let source = `touch:${zone}`;
  let streak = null;
  if (z.sensitivity === 2) {
    if (tier === 'low') { mood = 'angry'; source = `touch_rude:${zone}`; }
    else if (tier === 'mid') source = null; // flustered, but no points for it
  } else if (z.sensitivity === 1 && tier === 'low') source = null;
  if (count >= STREAK.angryAt) {
    streak = 'angry';
    mood = 'angry';
    source = z.sensitivity === 2 && tier === 'low' ? source : 'touch_rude:spam';
  } else if (count >= STREAK.annoyedAt) {
    streak = 'annoyed';
    if (mood !== 'angry') { mood = 'annoyed'; source = null; }
  }
  return { zone, mood, tier, streak, source, anim: `touch-${zone}`, fallback: MOOD_FX[mood], moodDelta: MOOD_DELTA[mood] };
}

// ---- lines ----------------------------------------------------------------------------------
// Generic lines for a character without her own (`touch.lines` in her file). All-ages.
const DEFAULT_LINES = {
  head: { low: ['诶？突然摸头……', '头发会乱掉的啦。'], mid: ['嘿嘿，再摸一下也行。', '被摸头好安心。'], high: ['你的手好暖，摸头最舒服了。', '只给你摸哦。'] },
  face: { low: ['别、别戳脸！', '我脸上有东西吗？'], mid: ['戳脸是什么新玩法？', '脸要被你捏圆了。'], high: ['哼，又捏我脸……算了，让你捏一下。'] },
  chest: { low: ['喂！这里不能碰，请保持距离。', '突然干什么！我要生气了。'], mid: ['这、这里不行啦！换个地方。', '我们是好朋友，但这里还是不可以。'], high: ['真是的……脸都红了，下不为例。', '你啊，就会欺负我。'] },
  hands: { low: ['要握手吗？你好。', '嗯？有事找我？'], mid: ['牵手手～', '你的手比我的大一圈呢。'], high: ['击个掌！我们果然最有默契。', '手凉吗？我帮你捂一会儿。'] },
  belly: { low: ['不要戳肚子！', '咕……我才没有吃多。'], mid: ['哈哈，好痒！', '肚子是秘密区域啦。'], high: ['痒痒痒！投降投降！'] },
  butt: { low: ['喂！手往哪儿放呢！', '再这样我就不理你了。'], mid: ['呀！这里不行！', '你、你是不是手滑了？'], high: ['笨蛋，往哪里碰呢……下不为例。', '哼，就这一次，原谅你。'] },
  legs: { low: ['那个……请不要碰腿。'], mid: ['腿麻了吗？我也有点。'], high: ['今天走了好多路，腿有点酸呢。'] },
  feet: { low: ['哇，别踩到我的鞋！', '脚、脚有什么好碰的。'], mid: ['好痒！脚底不行！', '哈哈哈，别挠啦。'], high: ['再挠我就要笑岔气了！', '鞋子是新的，好看吧？'] },
  tail: { low: ['尾巴不能随便摸！'], mid: ['尾巴摇起来了……才不是因为开心。'], high: ['尾巴只给你摸哦。'] },
  streak: {
    annoyed: ['戳戳戳，你是啄木鸟吗？', '同一个地方戳那么多下，会坏掉的！', '好啦好啦，知道你在了。'],
    angry: ['再戳我真的生气了！', '哼！不理你了！', '够了！让我静一静。'],
  },
};

// Extra lines for characters that allow adult content, with it switched on (affection.adultAllowed).
// Flirting and blushing only (design 8.2): never explicit, never a body description.
const ADULT_LINES = {
  chest: { high: ['坏蛋……想牵手就直说嘛。', '心跳得好快，都怪你。'] },
  butt: { high: ['哼，手这么不老实，罚你抱我一下。'] },
  legs: { high: ['腿借你当枕头？只许五分钟。'] },
  hands: { high: ['想约会就直说，手都牵上了。'] },
};

const STREAK_MOOD = { annoyed: 'annoyed', angry: 'angry' };

// Every line she may say for `reaction` (shape of reactionFor). A streak speaks for itself; otherwise
// the zone's lines for the tier. Adult lines join only when `settings` allow them for this character.
function touchLines(species, reaction, settings = null) {
  const own = (species && species.touch && species.touch.lines) || {};
  if (reaction.streak) {
    const k = STREAK_MOOD[reaction.streak];
    return [...((own.streak && own.streak[k]) || DEFAULT_LINES.streak[k])];
  }
  const zl = own[reaction.zone] || DEFAULT_LINES[reaction.zone];
  const pool = [...zl[reaction.tier]];
  const extra = ADULT_LINES[reaction.zone];
  if (extra && extra[reaction.tier] && species && aff().adultAllowed(settings, species.id)) pool.push(...extra[reaction.tier]);
  return pool;
}

// One line for the reaction, never the same as `last` when there is a choice.
function touchLine(species, reaction, { settings = null, rnd = Math.random, last = null } = {}) {
  const pool = touchLines(species, reaction, settings);
  const fresh = pool.length > 1 ? pool.filter((l) => l !== last) : pool;
  return fresh[Math.floor(rnd() * fresh.length)];
}

module.exports = {
  ZONE_IDS,
  REQUIRED_ZONES,
  ZONES,
  DEFAULT_ZONES,
  ZONE_ORDER,
  TIERS,
  STREAK,
  MOOD_FX,
  MOOD_DELTA,
  DEFAULT_LINES,
  ADULT_LINES,
  validateTouch,
  zonesFor,
  zoneAt,
  tierFor,
  nextStreak,
  reactionFor,
  touchLines,
  touchLine,
};
