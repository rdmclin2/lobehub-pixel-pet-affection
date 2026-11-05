'use strict';

// 房间小游戏 (docs/room.md): her room in 小屋 → 房间. Five activities (睡觉 / 工作 / 看手机 / 听音乐 / 打游戏), each
// one round long; a round that ends (finished, stopped early, or switched to another activity) settles into her
// needs. Pure: every function takes `now` (ms), so the tests drive time.
//
// Her numbers (0..100):
//   精力 energy  = the pet's own `energy` (pet-state.js: the same number her panel shows)
//   心情 mood    = the pet's own `mood`
//   饱腹 fullness = 100 - the pet's `hunger` (shown the other way round: more is better)
//   专注 focus   = the room's own number (`pet.room.focus`), only the room moves it
// They are kept on her base's entry (`pet.characters[base]`), so the pet window and the room share one save.

const { clamp } = require('./pet-state');

const ROUND_MS = 20 * 1000;
// a round stopped right after it started still counts a little: the owner sees that it did something
const MIN_FRACTION = 0.25;
const TIRED_BELOW = 15;
const STATS = ['energy', 'mood', 'focus', 'fullness'];
const STAT_LABEL = { energy: '精力', mood: '心情', focus: '专注', fullness: '饱腹' };

// What a whole round does. `fullness` is minus hunger; `action` is the sheet action she plays meanwhile
// (fx.js states, so the pet on the desktop can play it too); `needs` = energy it takes to start.
const ACTIVITIES = {
  sleep: { label: '睡觉', verb: '睡一觉', hotspot: 'bed', action: 'sleep', deltas: { energy: 35, mood: 6, focus: 8, fullness: -4 }, needs: 0 },
  work: { label: '工作', verb: '工作一会儿', hotspot: 'desk', action: 'think', deltas: { focus: 28, energy: -12, mood: -5, fullness: -8 }, needs: TIRED_BELOW },
  phone: { label: '看手机', verb: '刷会儿手机', hotspot: 'phone', action: 'look', deltas: { mood: 14, focus: -10, energy: -4 }, needs: 0 },
  music: { label: '听音乐', verb: '听几首歌', hotspot: 'music', action: 'happy', deltas: { mood: 16, energy: 6, focus: 6 }, needs: 0 },
  game: { label: '打游戏', verb: '打一局游戏', hotspot: 'game', action: 'play', deltas: { mood: 22, energy: -14, fullness: -8, focus: -6 }, needs: TIRED_BELOW },
};
const ACTIVITY_IDS = Object.keys(ACTIVITIES);

// Lines when a theme has none of its own.
const LINES = {
  sleep: { doing: ['呼……呼……', '睡一会儿就好……'], done: '睡饱了，精神满满！' },
  work: { doing: ['专心中，别打扰哦。', '这一段马上写完。'], done: '今天的活干完啦！' },
  phone: { doing: ['刷到一个好好笑的视频～', '再看一条就放下。'], done: '好啦，手机放下了。' },
  music: { doing: ['这首歌好好听～', '跟着节奏晃一晃。'], done: '听完这张唱片了，心情超好。' },
  game: { doing: ['冲呀！', '这关有点难……'], done: '赢啦！再来一局？' },
  tired: '好累……先睡一会儿再说吧。',
};

// One room per default character (src/characters). `status`: open = playable now; soon = 即将开放 (a preview
// card, nothing to click). Colours are the theme's own art palette, used inside the room only (not product UI).
// Hotspots and spots are in % of the room picture (x, y = top-left; w, h = size; spot = where her feet are).
const THEMES = [
  {
    id: 'dafeiyu',
    character: 'dafeiyu',
    name: '鲸鱼女仆的蓝色小屋',
    status: 'open',
    blurb: '浅蓝和奶白的少女房间：蕾丝床幔、蝴蝶结、鲸鱼抱枕。大肥鱼穿着招牌女仆装在这里睡觉、工作、刷手机、听唱片、打游戏。',
    motifs: ['蕾丝', '蝴蝶结', '鲸鱼'],
    palette: { primary: '#2C4A8A', accent: '#6FA8E8', base: '#FFFFFF', trim: '#E8D6A0' },
    outfit: 'daily',
    art: { background: 'rooms/dafeiyu/room.webp', width: 2048, height: 1152 },
    // furniture you click, in % of the picture (x, y = top-left). `chip: 'top'`: the label sits on its top edge
    // (where she never stands) instead of the bottom
    hotspots: {
      bed: { label: '床', x: 0, y: 10, w: 24.5, h: 70 },
      phone: { label: '手机', x: 23.8, y: 44, w: 7, h: 18 },
      desk: { label: '书桌和电脑', x: 51.5, y: 28.5, w: 19.5, h: 35.5, chip: 'top' },
      music: { label: '唱片机', x: 71.3, y: 33, w: 11, h: 30, chip: 'top' },
      game: { label: '游戏机', x: 82.3, y: 28, w: 17.5, h: 48, chip: 'top' },
    },
    // where she is for each activity: her feet (x, y, % of the picture) and her height (h, % of its height).
    // `tucked`: in bed under the blanket — x = her middle, y = the blanket's top edge (her chin), only her
    // head and shoulders show. `bubble`: where her line is said (its bottom middle), when not above her head
    spots: {
      idle: { x: 44, y: 86, h: 52 },
      sleep: { x: 21.5, y: 52.1, h: 50, tucked: true },
      work: { x: 60.5, y: 92, h: 50, bubble: { x: 44, y: 48 } },
      phone: { x: 38.5, y: 80, h: 50 },
      music: { x: 71, y: 90, h: 50, bubble: { x: 52, y: 58 } },
      game: { x: 92.5, y: 98, h: 48, bubble: { x: 70, y: 62 } },
    },
    // props drawn over the picture while an activity runs (% boxes): the monitor's screen, the record, the
    // TV's screen, the phone on the bedside table
    props: {
      monitor: { x: 57.8, y: 36.6, w: 6.8, h: 6.8 },
      record: { x: 73.5, y: 43.8, w: 4.7, h: 2.4 },
      tv: { x: 87.4, y: 37.4, w: 9.8, h: 16.6 },
      phone: { x: 25.1, y: 49.4, w: 1.6, h: 2 },
    },
    // the bed in picture pixels (art.width × art.height), for 睡觉: `blanket` = the cover over the mattress
    // (its first two points are the lace-trimmed top edge); `front` = the parts of the bed in front of her
    // (the foot posts and the footboard), redrawn over her and the blanket so she is tucked in, not pasted on
    bed: {
      blanket: [[20, 598], [492, 598], [462, 655], [440, 705], [381, 715], [344, 770], [20, 780]],
      front: [
        [[14, 0], [50, 0], [50, 920], [14, 920]],
        [[343, 0], [381, 0], [381, 920], [343, 920]],
        [[14, 717], [50, 717], [160, 697], [280, 735], [344, 755], [344, 885], [14, 885]],
      ],
      bow: [252, 612],
    },
    lines: {
      idle: ['咕噜~鱼片，今天想让我做什么？', '房间收拾得干干净净，女仆的本分~'],
      sleep: { doing: ['深度睡眠中……勿扰。', '呼……白饭……再来一碗……'], done: '咕噜~睡饱了，精神满满！' },
      work: { doing: ['女仆也要认真工作的。', '写完这段就去摸鱼……不，不摸。'], done: '活干完啦，鱼片夸我！' },
      phone: { doing: ['刷到一条鲸鱼视频，好可爱~', '再看一条……就一条。'], done: '手机放下了，眼睛休息一下。' },
      music: { doing: ['咕噜噜~这首歌好适合摸鱼。', '唱片转呀转~'], done: '听完一整面了，心情超好~' },
      game: { doing: ['冲呀！鲸鱼女仆不会输！', '这一关……让我想想。'], done: '赢啦！厉害了我的鲸~' },
    },
  },
  { id: 'claude', character: 'claude', name: '午后的书房', status: 'soon', blurb: '暖橘色的书房：满墙的书、热红茶和整理到一半的笔记。', motifs: ['书架', '红茶', '菊纹'], palette: { primary: '#C4622D', accent: '#F0B48A', base: '#FFF8F0', trim: '#7A3B1C' } },
  { id: 'grok', character: 'grok', name: '深夜的古堡房间', status: 'soon', blurb: '黑金配色的吸血鬼小房间：烛台、丝绒窗帘和一杯番茄汁。', motifs: ['烛台', '丝绒', '蝙蝠'], palette: { primary: '#8E1F33', accent: '#D4A23A', base: '#1E1418', trim: '#F2D27A' } },
  { id: 'gemini', character: 'gemini', name: '星星猫窝', status: 'soon', blurb: '紫色的星空阁楼：猫爬架、逗猫棒和一扇晒太阳的天窗。', motifs: ['星星', '猫爬架', '天窗'], palette: { primary: '#7B5CD6', accent: '#B9A6F2', base: '#F6F2FF', trim: '#FFD166' } },
  { id: 'gpt', character: 'gpt', name: '白龙的花园卧室', status: 'soon', blurb: '白玫瑰和淡紫色的卧室：清单墙、写诗的小桌和夜里的长聊。', motifs: ['白玫瑰', '清单墙', '龙鳞'], palette: { primary: '#8E7FC8', accent: '#D9D2F2', base: '#FFFFFF', trim: '#B8A4E0' } },
];
const themeById = (id) => THEMES.find((t) => t.id === id) || null;
// The room a character lives in (her base persona's theme), else the first one.
const themeFor = (base) => themeById(base) || THEMES[0];

// The room's part of her entry, created the first time.
function ensure(pet) {
  if (!pet.room || typeof pet.room !== 'object') pet.room = {};
  const r = pet.room;
  if (typeof r.focus !== 'number') r.focus = 50;
  if (r.activity === undefined) r.activity = null;
  if (r.last === undefined) r.last = null;
  if (!r.totals || typeof r.totals !== 'object') r.totals = {};
  return r;
}

const stats = (pet) => {
  const r = ensure(pet);
  return { energy: Math.round(pet.energy ?? 0), mood: Math.round(pet.mood ?? 0), focus: Math.round(r.focus), fullness: Math.round(100 - (pet.hunger ?? 0)) };
};

const pick = (list, rnd) => (Array.isArray(list) ? list[Math.floor(rnd() * list.length) % list.length] : list) || '';
const linesOf = (theme, kind) => (theme && theme.lines && theme.lines[kind]) || LINES[kind];

// Apply `fraction` of a round of `kind` to her numbers; -> the deltas actually applied (after clamping).
function apply(pet, kind, fraction) {
  const r = ensure(pet);
  const out = {};
  const before = stats(pet);
  for (const [k, d] of Object.entries(ACTIVITIES[kind].deltas)) {
    const v = d * fraction;
    if (k === 'energy') pet.energy = clamp(pet.energy + v);
    else if (k === 'mood') pet.mood = clamp(pet.mood + v);
    else if (k === 'fullness') pet.hunger = clamp(pet.hunger - v);
    else if (k === 'focus') r.focus = clamp(r.focus + v);
  }
  const after = stats(pet);
  for (const k of STATS) if (after[k] !== before[k]) out[k] = after[k] - before[k];
  return out;
}

// End the running activity (finished or not). -> { kind, complete, fraction, deltas, line, at } or null.
function settle(pet, now, { roundMs = ROUND_MS, theme = null } = {}) {
  const r = ensure(pet);
  const a = r.activity;
  if (!a || !ACTIVITIES[a.kind]) {
    r.activity = null;
    return null;
  }
  const elapsed = Math.max(0, now - a.startedAt);
  const complete = elapsed >= roundMs;
  const fraction = complete ? 1 : Math.max(MIN_FRACTION, Math.round((elapsed / roundMs) * 100) / 100);
  const deltas = apply(pet, a.kind, fraction);
  const t = (r.totals[a.kind] = r.totals[a.kind] || { count: 0, completed: 0, ms: 0 });
  t.count += 1;
  if (complete) t.completed += 1;
  t.ms += Math.min(elapsed, roundMs);
  const line = complete ? linesOf(theme, a.kind).done : `${ACTIVITIES[a.kind].label}先到这里。`;
  r.activity = null;
  r.last = { kind: a.kind, complete, fraction, deltas, line, at: now };
  pet.lastInteractionAt = now;
  return r.last;
}

// Start `kind`: a running activity is settled first (switching counts what was done). Too tired for work /
// games → { ok: false, reason: 'tired' } and nothing changes. -> { ok, activity, settled, line }
function start(pet, kind, now, { roundMs = ROUND_MS, theme = null, rnd = Math.random } = {}) {
  if (!ACTIVITIES[kind]) return { ok: false, reason: 'bad-activity' };
  const r = ensure(pet);
  if (r.activity && r.activity.kind === kind) return { ok: true, activity: r.activity, settled: null, line: null, same: true };
  // the energy check sees her numbers as they will be once the running one is settled
  const settled = settle(pet, now, { roundMs, theme });
  if ((pet.energy ?? 0) < ACTIVITIES[kind].needs) return { ok: false, reason: 'tired', settled, line: LINES.tired };
  r.activity = { kind, startedAt: now };
  pet.lastInteractionAt = now;
  return { ok: true, activity: r.activity, settled, line: pick(linesOf(theme, kind).doing, rnd) };
}

// What the console shows: the running activity with its progress, her numbers, the last result.
function view(pet, now, { roundMs = ROUND_MS } = {}) {
  if (!pet) return null;
  const r = ensure(pet);
  const a = r.activity;
  const activity = a ? { kind: a.kind, startedAt: a.startedAt, roundMs, progress: Math.min(1, Math.max(0, (now - a.startedAt) / roundMs)) } : null;
  return { activity, stats: stats(pet), last: r.last, totals: r.totals, roundMs };
}

// The definitions the console renders from (no functions: it goes over IPC as is).
const catalog = () => ({
  activities: ACTIVITY_IDS.map((id) => ({ id, ...ACTIVITIES[id], lines: LINES[id] })),
  themes: THEMES,
  stats: STATS.map((id) => ({ id, label: STAT_LABEL[id] })),
});

module.exports = { ROUND_MS, MIN_FRACTION, TIRED_BELOW, STATS, STAT_LABEL, ACTIVITIES, ACTIVITY_IDS, LINES, THEMES, themeById, themeFor, ensure, stats, settle, start, view, catalog };
