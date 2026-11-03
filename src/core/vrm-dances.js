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
  const SOURCES = ['vidol-pack', 'mmd-folder', 'vmd', 'vrma', 'store', 'builtin'];
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

  // ---------- importing (§5.5) ----------
  const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac)$/i;
  const COVER_EXT = /\.(jpe?g|png|webp)$/i;
  const MOTION_EXT = /\.vmd$/i;
  const base = (f) => String(f).replace(/^.*[\\/]/, '');
  const stem = (f) => base(f).replace(/\.[^.]+$/, '').toLowerCase();
  const ext = (f) => { const m = /\.([^.]+)$/.exec(base(f)); return m ? m[1].toLowerCase() : ''; };

  // The words shown when an import cannot go on: what happened and what to do (W-05).
  const IMPORT_ERRORS = {
    'no-files': '没有选到文件。选上舞蹈的 .vmd 文件（可以同时选上音乐和封面），或者选整个舞蹈文件夹。',
    'no-motion': '没有找到舞蹈动作文件（.vmd）。选上舞蹈的 .vmd 文件再试。',
    'only-camera': '这里的 .vmd 只有镜头或道具的动作，没有人形骨骼的舞蹈动作。找到跳舞的那个 .vmd（通常最大）再导入。',
    'bad-vmd': '这个 .vmd 文件读不出来，可能已损坏，或者不是 MMD 动作文件。',
    'not-anim': '这个素材包不是舞蹈（meta.json 的 type 不是 anim），没法导入。',
    'encrypted-audio': '这个音乐文件是加密格式（.ncm），播放不了。换成 mp3 / wav / ogg / m4a / flac 再导入，或者不带音乐导入。',
    'bad-audio': '音乐只能是 mp3 / wav / ogg / m4a / flac 文件。',
    'bad-cover': '封面只能是 jpg / png / webp 图片。',
    'too-big': '文件太大了（动作文件最多 64 MB，音乐最多 200 MB，封面最多 10 MB）。',
    'bake-failed': '动作转换失败：这个 .vmd 里的动作没法套到 VRM 人形骨骼上。',
    'no-library': '舞蹈库的位置不可用（不能放在应用目录里），没法保存导入的舞蹈。',
    'write-failed': '保存舞蹈时写文件失败，检查一下磁盘空间和数据目录的权限。',
    expired: '这次导入已经过期了，重新选一次文件。',
    busy: '正在导入上一支舞蹈，等它完成再导入下一支。',
    canceled: '已取消导入。',
  };
  const importError = (reason, extra = {}) => ({ ok: false, reason, message: IMPORT_ERRORS[reason] || IMPORT_ERRORS['bake-failed'], ...extra });

  // Who made the motion, from its readme (shown with the dance): "Motion by …", "动作作者：…".
  function creditOf(text) {
    const s = String(text || '');
    const m = /motion[ \t]*(?:by|:|：)[ \t]*([^\r\n]{1,80})/i.exec(s) || /(?:动作|動作|モーション)(?:作者|制作|製作)?[ \t]*[:：][ \t]*([^\r\n]{1,80})/.exec(s);
    return m ? m[0].trim().slice(0, 120) : null;
  }

  // A dance's folder name: an ASCII slug of its name and 4 random hex digits ("gokuraku-3f2a"; "dance-3f2a" for a
  // name with no ASCII letters at all).
  function danceId(name, rand = Math.random) {
    const slug = String(name || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    const tail = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0');
    return `${slug || 'dance'}-${tail}`;
  }

  // What to import from what was picked (§5.5 step 2), pure. `listing`: { files: [{ path, size }], meta?: parsed
  // meta.json | null, motions: [{ path, kind: motion | camera | prop | empty | bad, keys }], folder?: name }.
  // → { ok, source, name, motion, others, audio, audios, cover, covers, readme, warnings } or an import error.
  function detectDance(listing) {
    const files = (listing && listing.files) || [];
    if (!files.length) return importError('no-files');
    const motions = (listing.motions || []).filter((m) => MOTION_EXT.test(m.path));
    const songs = files.filter((f) => AUDIO_EXT.test(f.path));
    const pics = files.filter((f) => COVER_EXT.test(f.path));
    const encrypted = files.filter((f) => /\.ncm$/i.test(f.path));
    const meta = listing.meta && typeof listing.meta === 'object' ? listing.meta : null;
    const warnings = [];
    let source = listing.folder ? 'mmd-folder' : 'vmd';
    let name = listing.folder || null;
    let motion = null;
    let metaAudio = null;
    if (meta) {
      if (meta.type !== 'anim') return importError('not-anim');
      source = 'vidol-pack';
      if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name.trim().slice(0, 60);
      const want = typeof meta.src === 'string' ? base(meta.src).toLowerCase() : null;
      motion = motions.find((m) => base(m.path).toLowerCase() === want && m.kind === 'motion') || null;
      metaAudio = typeof meta.audio === 'string' ? base(meta.audio).toLowerCase() : null;
    }
    const dancers = motions.filter((m) => m.kind === 'motion').sort((a, b) => b.keys - a.keys);
    if (!motion) {
      if (!motions.length) return importError('no-motion');
      if (!dancers.length) return importError(motions.every((m) => m.kind === 'bad') ? 'bad-vmd' : 'only-camera');
      motion = dancers[0];
    }
    if (!name) name = base(motion.path).replace(/\.[^.]+$/, '');
    const others = dancers.filter((m) => m !== motion).map((m) => m.path);
    if (others.length) warnings.push(`文件夹里还有 ${others.length} 个舞蹈动作，默认用骨骼帧最多的那个，可以在下面换。`);
    // the music: the pack's own, else the one named like the motion, else the largest
    const bySize = songs.slice().sort((a, b) => b.size - a.size);
    const audio = (metaAudio && songs.find((f) => base(f.path).toLowerCase() === metaAudio)) || songs.find((f) => stem(f.path) === stem(motion.path)) || bySize[0] || null;
    if (!audio && encrypted.length) warnings.push(IMPORT_ERRORS['encrypted-audio']);
    const cover = pics.find((f) => /^cover\./i.test(base(f.path))) || pics.find((f) => /^thumb\./i.test(base(f.path))) || pics[0] || null;
    const readme = files.find((f) => /\.txt$/i.test(f.path) && /re[a]?d[-_ ]?me/i.test(base(f.path))) || files.find((f) => /\.txt$/i.test(f.path)) || null;
    return {
      ok: true, source, name, motion: motion.path, others, audio: audio ? audio.path : null, audios: bySize.map((f) => f.path),
      cover: cover ? cover.path : null, covers: pics.map((f) => f.path), readme: readme ? readme.path : null, warnings,
    };
  }

  return { ID_RE, FILE_RE, DEMO_ID, SHORT_LOOP, LOOK_LABEL, AUDIO_EXT, COVER_EXT, IMPORT_ERRORS, demoEntry, cleanDanceIndex, listDances, publicEntry, findDance, pickDance, cannotDance, creditOf, danceId, detectDance, importError, fileExt: ext };
});
