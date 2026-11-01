'use strict';

const Fx = window.PetFx;
const Voice = window.PetVoice;
const IVoice = window.PetInteractionVoice;
const $ = (id) => document.getElementById(id);
// A visiting model-chan (同屏伙伴) runs this same page in its own small window: index.html?visitor=<id>.
const VISITOR = new URLSearchParams(location.search).get('visitor');
const FOOD_SPRITE = { rice: 'rice', cookie: 'cookie', fruit: 'fruit' };
// 素材署名: every character's credits, from its file (src/characters/<id>.json).
const credits = () => ['角色均为同人形象，不是厂商官方形象；美术仅限非商业使用。', ...info.species.flatMap((sp) => ['', `${sp.title}「${sp.nameZh}」`, ...sp.credits.map((c) => `· ${c}`)])].join('\n');

let info = null; // { species[], foods, testMode }
let view = null; // latest pet view from main
let selected = null;
let thinking = false;
let naming = null; // { id, value }: the first-meeting name form that is open (kept across panel re-renders)
let arriving = null; // nameZh of a character on her way (her agent is being created), shown instead of 思考中
let eating = null;
let talkUntil = 0;
let flashUntil = 0;
let revealSpecies = null;
let bubbleTimer = null;
let bubbleHold = false; // pointer over the bubble: keep it open so a long reply can be scrolled and read
let thinkTimer = null;
let attachments = []; // [{ kind:'image', dataUrl, name } | { kind:'path', path, name }] waiting for the next message
let pointerInside = false;
let fx = null; // the shared effects layer (fx.js), created at boot
let settings = null; // latest settings view: { needsAgeGate, ageConfirmed, adultContent, ... }
let gateAfter = null; // what to do once the age gate is answered
let panelKind = null; // 'wardrobe' | 'topics' | 'characters' | 'advanced' | 'history' while a panel is open
let panelNew = new Set(); // items that were "new" when the panel opened (marked seen right after)
let toastTimer = null;
const notedBlocks = new Set(); // "cooldown" / "cap" notes are shown once per launch

// Every settings update also carries the pet size: the character area scales with it (style.css .stage).
function setSettings(st) {
  const wasOn = !!(settings && settings.prefs && settings.prefs.voice);
  settings = st;
  if (wasOn && !(st && st.prefs && st.prefs.voice)) stopSpeech('voice-off'); // 朗读 off: quiet at once, nothing pending
  syncPrewarm();
  if (st && st.ttsStatus && panelKind === 'advanced') paintVoiceStatus();
  syncMic(); // 🎤 only while 语音输入 is on
  if (st && st.petScale && !VISITOR) showScale(st.petScale); // a visitor keeps her own small size
}

function showScale(k) {
  document.documentElement.style.setProperty('--pet-scale', String(k));
  $('resize-grip').setAttribute('aria-valuenow', String(Math.round(k * 100)));
}

// ---------- resizing the pet: corner handle, Ctrl/⌘ + wheel ----------
// The window follows (main resizes it around its bottom-right corner); the size is saved on release.
let resizing = null;
let scaleFrame = 0;
function previewScale(k) {
  const r = settings.petScaleRange;
  k = Math.round(Math.min(r.max, Math.max(r.min, k)) * 100) / 100;
  showScale(k);
  if (!scaleFrame) scaleFrame = requestAnimationFrame(async () => {
    scaleFrame = 0;
    const used = await window.pet.previewPetScale(Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')));
    showScale(used);
  });
  return k;
}
async function commitScale(k) {
  const r = await window.pet.setPetScale(k);
  if (r && r.ok) setSettings(r.settings);
}
function bindResize() {
  const grip = $('resize-grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    resizing = { x: e.screenX, y: e.screenY, k: settings.petScale, cur: settings.petScale };
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    // up and to the left grows the pet; 190 px of drag (the character's height) doubles it
    const d = (resizing.y - e.screenY + (resizing.x - e.screenX)) / 2;
    resizing.cur = previewScale(resizing.k * (1 + d / 190));
  });
  const end = async () => {
    if (!resizing) return;
    const k = resizing.cur;
    resizing = null;
    document.body.classList.remove('resizing');
    await commitScale(k);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('mousedown', (e) => e.stopPropagation()); // not a window drag
  let wheelTimer = null;
  let wheelK = null;
  $('stage').addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    wheelK = previewScale((wheelK || settings.petScale) * (e.deltaY < 0 ? 1.05 : 1 / 1.05));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { const k = wheelK; wheelK = null; commitScale(k); }, 400);
  }, { passive: false });
}

const speciesOf = (id) => info.species.find((s) => s.id === id);
// How a companion looks comes from its pet pack (`view.look`, see core/packs.js): a picture per outfit, or
// a pixel sprite sheet per outfit with one row of frames per action. Dafeiyu plays her own clips when
// they are picked under 外观 (look: null).
const isVideo = (id) => !!id && !!speciesOf(id) && speciesOf(id).art === 'video' && !(view && view.pet.speciesId === id && view.look);

// ---------- looks: pictures, animated pixel sprites and rigs ----------
const sprites = new Set(); // live sprite canvases: { canvas, look, sheet, k, action() }
const rigs = new Set(); // live figures, 全动态 (rig.js) or Live2D (live2d.js): { canvas, figure, action() }
// a look drawn live every frame instead of from frames: which script draws it
// (VRM: window.PetVRM, the three-vrm renderer; until it is loaded a VRM look shows its picture / placeholder)
const LIVE_KINDS = { rig: () => window.PetRig, live2d: () => window.PetLive2D, vrm: () => window.PetVRM };
const isLive = (look) => !!look && !!LIVE_KINDS[look.kind] && !!LIVE_KINDS[look.kind]();
// A whole HD sheet decodes to about 86 MB (2656×8136), so only the desktop pet draws from the full sheet.
// Smaller looks (cards, the wardrobe, the hatch screen) draw from a half-size copy, and a sheet nothing
// shows any more is let go after a while: the wardrobe would otherwise keep every outfit's sheet decoded.
const sheets = new Map(); // `${k}|${url}` -> { src (ImageBitmap at 1/k, or the Image if that failed), users, timer }
const SHEET_KEEP_MS = 10000; // a sheet shown again soon (the same look redrawn) is not loaded twice
// Decoded as ImageBitmaps, which close() frees at once: an <img> keeps its decoded pixels in Blink's cache.
function loadSheet(url, k) {
  return fetch(url)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`))))
    .then((blob) => createImageBitmap(blob))
    .then((full) => {
      if (k === 1) return full;
      const small = createImageBitmap(full, { resizeWidth: Math.round(full.width / k), resizeHeight: Math.round(full.height / k), resizeQuality: 'high' });
      return small.finally(() => full.close());
    });
}
function useSheet(url, k) {
  const key = `${k}|${url}`;
  let e = sheets.get(key);
  if (!e) {
    e = { src: null, users: 0, timer: 0, ready: null };
    const entry = e;
    e.ready = loadSheet(url, k).then((bmp) => {
      if (sheets.get(key) === entry) entry.src = bmp;
      else bmp.close();
    }, () => {
      const img = new Image(); // cannot be fetched: drawn from the picture itself
      if (url.startsWith('pack:')) img.crossOrigin = 'anonymous'; // pack:// answers with CORS: her pixels stay readable for touch hit tests
      img.src = url;
      entry.src = img;
      return img.decode();
    });
    sheets.set(key, e);
  }
  clearTimeout(e.timer);
  e.users++;
  return e;
}
// Settles when every sheet of `url` in use can be drawn (rejects if one cannot be loaded at all).
const sheetReady = (url) => Promise.all([...sheets].filter(([key]) => key.endsWith(`|${url}`)).map(([, e]) => e.ready));
function dropSheet(url, k) {
  const key = `${k}|${url}`;
  const e = sheets.get(key);
  if (!e || --e.users > 0) return;
  e.timer = setTimeout(() => {
    if (e.users > 0) return;
    sheets.delete(key);
    if (e.src && e.src.close) e.src.close();
    e.src = null;
  }, SHEET_KEEP_MS);
}
// An element showing `look`; `action` (a function) picks the sprite action each frame.
function lookEl(look, { className = 'look', alt = '', action = () => 'idle', speciesId = null } = {}) {
  if (!look) {
    // Dafeiyu's clip is 16:9 with the character small in the middle: crop it like the desktop pet does
    const wrap = document.createElement('div');
    wrap.className = `${className} vlook`;
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    if (speciesId) v.src = `${speciesOf(speciesId).clipDir}/${[].concat(speciesOf(speciesId).clips.idle)[0]}`;
    wrap.appendChild(v);
    return wrap;
  }
  if (isLive(look) && className === 'char') {
    // the desktop pet is drawn live; anywhere else (cards, the wardrobe) her picture stands in
    const c = document.createElement('canvas');
    c.className = `${className} sprite rig ${look.kind}`;
    c.width = look.kind === 'rig' ? look.model.size[0] : 332;
    c.height = look.kind === 'rig' ? look.model.size[1] : 452;
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', alt);
    try {
      const figure = LIVE_KINDS[look.kind]().createFigure(c, look);
      const r = { canvas: c, figure, action, ok: false };
      figure.ready.then((ok) => { if (ok === false) return; r.ok = true; rigs.add(r); }, (e) => rigFailed(c, look, alt, className, e));
    } catch (e) {
      setTimeout(() => rigFailed(c, look, alt, className, e));
    }
    return c;
  }
  if (look.kind === 'sprites') {
    const c = document.createElement('canvas');
    c.className = `${className} sprite${look.pixelated ? ' pixelated' : ''}`;
    // the half-size copy for small looks, only for big smooth frames: pixel art stays block for block
    const k = className !== 'char' && !look.pixelated && look.frame.width >= 400 ? 2 : 1;
    c.width = Math.round(look.frame.width / k);
    c.height = Math.round(look.frame.height / k);
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', alt);
    const s = { canvas: c, look, k, sheet: useSheet(look.url, k), action, start: performance.now() };
    sprites.add(s);
    drawSprite(s, performance.now());
    return c;
  }
  if (look.kind === 'vrm') return vrmPictureEl(look, className, alt);
  const img = document.createElement('img');
  if (look.url.startsWith('pack:')) img.crossOrigin = 'anonymous';
  img.className = `${className}${look.pixelated ? ' pixelated' : ''}`;
  img.alt = alt;
  img.draggable = false;
  img.src = look.url;
  return img;
}
// A VRM look not drawn live (lists, the wardrobe, or before the 3D renderer is there): the picture the
// renderer saved for the pack over a "VRM" tile, so a model without a picture yet is still recognisable.
function vrmPictureEl(look, className, alt) {
  const wrap = document.createElement('div');
  wrap.className = `${className} vrm-look${look.locked ? ' locked' : ''}`;
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', alt);
  wrap.innerHTML = '<span class="vrm-badge">VRM</span>';
  if (look.url) {
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.alt = '';
    img.draggable = false;
    img.hidden = true; // shown once it is a real picture: the importer's 1×1 stand-in is not one
    img.addEventListener('load', () => { img.hidden = img.naturalWidth <= 1; });
    img.src = look.url;
    wrap.appendChild(img);
  }
  return wrap;
}
function drawSprite(s, now) {
  const { look, canvas, k } = s;
  const img = s.sheet.src;
  if (!img || (img instanceof HTMLImageElement && (!img.complete || !img.naturalWidth))) return;
  const want = Fx.resolveAction(s.action(), (n) => !!look.actions[n]).name;
  const a = look.actions[want] || look.actions.idle;
  if (s.cur !== want) { s.cur = want; s.start = now; }
  const i = Math.floor(((now - s.start) / 1000) * a.fps) % a.frames;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = !look.pixelated;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { width: w, height: h } = look.frame;
  ctx.drawImage(img, ((a.col + i) * w) / k, (a.row * h) / k, w / k, h / k, 0, 0, canvas.width, canvas.height);
  const frame = `${look.url}#${a.row}:${a.col + i}`; // which frame is up (touch hit tests cache its pixels)
  if (canvas.dataset.frame !== frame) canvas.dataset.frame = frame;
}
// No WebGL (or a layer that would not load): show her picture instead of an empty canvas.
function rigFailed(canvas, look, alt, className, e) {
  console.warn('[rig] falling back to the picture:', e && e.message);
  if (!canvas.isConnected) return;
  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  img.className = className;
  img.alt = alt;
  img.draggable = false;
  img.src = look.url;
  canvas.replaceWith(look.kind === 'vrm' ? vrmPictureEl(look, className, alt) : img);
}
// What her voice is doing right now: 'audio' (a TTS clip playing), 'system' (Web Speech) or null. A VRM
// figure moves her mouth with it (lip sync), whatever state she is in (an interaction line is read during pat).
function voiceNow() {
  if (speechAudio && !speechAudio.paused && !speechAudio.ended) return 'audio';
  if (window.speechSynthesis && speechSynthesis.speaking) return 'system';
  return null;
}
function tickRigs(now) {
  for (const r of rigs) {
    if (!r.canvas.isConnected) { r.figure.dispose(); rigs.delete(r); continue; }
    const state = r.action();
    const mood = state.startsWith('touch-') && lastTouch ? lastTouch.mood : null;
    r.figure.draw({ t: now / 1000, state, mood, talking: state === 'talk', voice: voiceNow(), win: [window.screenX, window.screenY] });
  }
}
function tickSprites(now) {
  for (const s of sprites) {
    if (!s.canvas.isConnected) { sprites.delete(s); dropSheet(s.look.url, s.k); continue; }
    drawSprite(s, now);
  }
}
function setLook(slot, look, opts) {
  slot.textContent = '';
  slot.appendChild(lookEl(look, opts));
}

// A video character plays one clip per state (resolved through fx.FALLBACK when it has none).
// A state may have several clips (variants, e.g. Dafeiyu's click reactions): each time it starts, one
// is picked that did not play last time.
function playClip(video, sp, key, loop = true) {
  if (video.dataset.key === key) return;
  video.dataset.key = key;
  video.loop = loop;
  const file = Fx.pickVariant(sp.clips[key], video.dataset.file || null);
  video.dataset.file = file;
  video.src = `${sp.clipDir}/${file}`;
  video.play().catch(() => {});
}
const clipFor = (sp, state) => Fx.resolveAction(state, (n) => !!sp.clips[n]);

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
}

// A character's portrait: its daily look (a sprite plays `state`), or its idle clip.
function portraitEl(sp, className, state = 'idle') {
  return lookEl(sp.portrait, { className, alt: sp.nameZh, action: () => state, speciesId: sp.id });
}

// ---------- 18+ confirmation (design 8.3) ----------
// Shown before anything else on first launch, and again when someone who chose "all ages" wants to turn
// adult content on from the menu. Closing the window without answering keeps adult content off.
function showAgeGate(after) {
  gateAfter = after;
  window.pet.place('onboarding');
  show('age-gate');
}

async function answerAgeGate(adult) {
  const r = await window.pet.confirmAge(adult);
  setSettings(r.settings);
  const after = gateAfter;
  gateAfter = null;
  if (after) after(r);
}

// ---------- onboarding: choose a model-chan ----------
function buildCards() {
  const wrap = $('cards');
  wrap.innerHTML = '';
  for (const sp of info.species) {
    const card = document.createElement('button');
    card.className = 'char-card';
    card.dataset.species = sp.id;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');
    card.setAttribute('aria-label', `${sp.title}，${sp.nameZh}`);
    card.style.setProperty('--accent', sp.accent);
    card.innerHTML = '<div class="pic"></div><div class="vendor"></div><div class="nm"></div>';
    card.querySelector('.pic').appendChild(portraitEl(sp, 'card-look'));
    card.querySelector('.vendor').textContent = sp.vendor;
    card.querySelector('.nm').textContent = sp.nameZh;
    card.addEventListener('click', () => selectCard(sp.id));
    wrap.appendChild(card);
  }
}

function selectCard(id) {
  selected = id;
  const sp = speciesOf(id);
  for (const c of document.querySelectorAll('.char-card')) {
    c.classList.toggle('selected', c.dataset.species === id);
    c.setAttribute('aria-checked', String(c.dataset.species === id));
  }
  const box = $('card-info');
  box.textContent = '';
  const b = document.createElement('b');
  b.textContent = `${sp.title}：`;
  box.appendChild(b);
  box.appendChild(document.createTextNode(sp.blurb));
  $('hatch-btn').disabled = false;
  $('pet-name').placeholder = `给她起个名字（默认 ${sp.nameZh}）`;
}

function showOnboarding() {
  selected = null;
  $('hatch-btn').disabled = true;
  $('card-info').textContent = '点一位看看。';
  $('pet-name').value = '';
  buildCards();
  show('onboarding');
}

// ---------- hatching ----------
const STEP_ORDER = ['checking-login', 'login', 'choose-space', 'creating-agent', 'connecting-device', 'hatching'];

function setStep(step) {
  const idx = STEP_ORDER.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  });
  $('hatch-look').dataset.progress = String(Math.min(3, Math.max(0, idx > 3 ? 3 : idx)));
}

// Personal space first (the default), then every workspace. Resolves with the chosen space.
function chooseSpace({ workspaces, pinned }) {
  const list = $('space-list');
  list.innerHTML = '';
  const options = [{ workspaceId: null, name: '个人空间', hint: '只有你自己能看到（推荐）' }, ...workspaces.map((w) => ({ workspaceId: w.id, name: w.name, hint: 'workspace' }))];
  options.forEach((o, i) => {
    const row = document.createElement('label');
    row.className = 'space-opt';
    row.innerHTML = '<input type="radio" name="space" /><span class="nm"></span><span class="hint"></span>';
    row.querySelector('input').value = String(i);
    row.querySelector('input').checked = i === 0;
    row.querySelector('.nm').textContent = o.name;
    row.querySelector('.hint').textContent = o.hint;
    list.appendChild(row);
  });
  const note = $('space-note');
  const refreshNote = () => {
    const personal = list.querySelector('input:checked').value === '0';
    note.classList.toggle('hidden', !(personal && pinned));
    if (pinned) note.textContent = `你的 lh 目前默认用 workspace「${pinned.name}」。放进个人空间会运行 lh workspace use --personal，把终端里 lh 的默认空间也切回个人。`;
  };
  list.addEventListener('change', refreshNote);
  refreshNote();
  $('hatching').classList.add('choosing'); // the portrait makes room for the choice
  $('space-box').classList.remove('hidden');
  return new Promise((resolve) => {
    $('space-go').onclick = () => {
      const o = options[Number(list.querySelector('input:checked').value)];
      $('space-box').classList.add('hidden');
      $('hatching').classList.remove('choosing');
      resolve({ workspaceId: o.workspaceId, name: o.name, switchToPersonal: !o.workspaceId && !!pinned });
    };
  });
}

async function startHatch() {
  const species = speciesOf(selected);
  revealSpecies = null;
  // she is asleep (dimmed) while LobeHub is set up, and wakes up when the agent is ready
  setLook($('hatch-look'), species.portrait, { className: 'look', alt: species.nameZh, action: () => 'sleep', speciesId: species.id });
  $('hatch-look').classList.add('asleep');
  $('hatch-look').classList.remove('hidden');
  $('hatch-look').dataset.progress = '0';
  $('hatch-error').classList.add('hidden');
  $('hatch-retry').classList.add('hidden');
  $('login-box').classList.add('hidden');
  $('space-box').classList.add('hidden');
  $('step-device').classList.toggle('hidden', !$('local-opt').checked);
  $('hatch-title').textContent = '唤醒中……';
  document.querySelectorAll('#steps li').forEach((li) => li.classList.remove('done', 'active'));
  show('hatching');

  const offStep = window.pet.onHatchStep(setStep);
  const offLogin = window.pet.onLoginPrompt(({ url, code, browserFailed }) => {
    $('login-msg').textContent = browserFailed ? '没能自动打开浏览器，已为你打开登录页。请输入验证码：' : '浏览器已打开登录页，请确认验证码：';
    $('login-code').textContent = code || '（见浏览器页面）';
    $('login-url').textContent = url;
    $('login-box').classList.remove('hidden');
  });
  let res = await window.pet.spaces();
  if (res.ok) {
    $('login-box').classList.add('hidden');
    let space = { workspaceId: null, name: '个人空间', switchToPersonal: false };
    // Only ask when there is a choice to make.
    if (res.workspaces.length) {
      setStep('choose-space');
      space = await chooseSpace(res);
    }
    res = await window.pet.hatch(species.id, $('pet-name').value, $('local-opt').checked, space);
  }
  offStep();
  offLogin();

  if (!res.ok) {
    $('hatch-title').textContent = '唤醒失败';
    $('hatch-error').textContent = res.error;
    $('hatch-error').classList.remove('hidden');
    $('hatch-retry').classList.remove('hidden');
    return;
  }
  document.querySelectorAll('#steps li').forEach((li) => { li.classList.remove('active'); li.classList.add('done'); });
  $('login-box').classList.add('hidden');
  flashUntil = performance.now() + 700;
  revealSpecies = res.view.pet.speciesId;
  $('hatch-title').textContent = `${res.view.pet.name} 醒来了！`;
  const sp = speciesOf(revealSpecies);
  // the wake-up: every character plays its `hatch` state (a clip, or a sprite action)
  $('hatch-look').classList.remove('asleep');
  if (sp.art === 'video' && !sp.portrait) {
    $('hatch-look').classList.add('hidden');
    $('hatch-vwrap').classList.remove('hidden');
    $('hatch-video').dataset.key = '';
    playClip($('hatch-video'), sp, clipFor(sp, 'hatch').name, false);
  } else {
    setLook($('hatch-look'), sp.portrait, { className: 'look', alt: sp.nameZh, action: () => 'hatch' });
  }
  setTimeout(() => {
    enterPet(res.view);
    if (res.localError) setTimeout(() => say(`（没能连上这台电脑，文件功能先关着：${String(res.localError).slice(0, 60)}）`, 'error', 'fallback', res.localError), 600);
    else if (res.localWarning) setTimeout(() => say(`（${res.localWarning}）`, 'error', 'fallback', res.localWarning), 600);
  }, sp.art === 'video' && !sp.portrait ? Fx.oneShotMs(true, 'hatch') : Fx.oneShotMs(false, 'hatch') + 600);
}

// ---------- pet ----------
function applyArt() {
  const video = isVideo(view && view.pet.speciesId);
  $('char-wrap').classList.toggle('hidden', video);
  $('vwrap').classList.toggle('hidden', !video);
  if (video) return;
  const key = `${view.look.packId}/${view.outfit}${view.look.live2d ? `@${view.look.live2d.height}` : ''}${view.look.vrm ? `@${view.look.vrm.height}#${view.look.model}~${view.look.vrm.idle || ''}` : ''}`; // a Live2D / VRM model's size is redrawn too
  const slot = $('pet-look');
  if (slot.dataset.key !== key) {
    slot.dataset.key = key;
    setLook(slot, view.look, { className: 'char', alt: view.pet.name, action: petAction });
    $('char-wrap').classList.toggle('has-sprites', view.look.kind === 'sprites' || isLive(view.look));
    $('char-wrap').dataset.outfit = view.outfit;
    // a short sparkle so the change of clothes is noticed
    $('char-wrap').classList.remove('changed');
    void $('char-wrap').offsetWidth;
    $('char-wrap').classList.add('changed');
  }
}

function enterPet(v) {
  view = v;
  syncPrewarm();
  const p = pendingSpeech;
  pendingSpeech = null;
  if (p && performance.now() - p.at < 15000) speak(p.m);
  revealSpecies = null;
  $('hatch-vwrap').classList.add('hidden');
  $('hatch-look').classList.add('hidden');
  fx.clear();
  fx.stopThrow();
  $('pet-video').dataset.key = '';
  window.pet.place('pet');
  show('pet-screen');
  applyArt();
  refreshHud();
}

function barColor(v, invert) {
  const good = invert ? 100 - v : v;
  return good > 60 ? '#6cc16a' : good > 30 ? '#f2b53a' : '#e0455f';
}

function refreshHud() {
  if (!view) return;
  const p = view.pet;
  const set = (id, v, invert) => {
    const el = $(id);
    el.style.setProperty('--v', `${invert ? 100 - v : v}%`);
    el.style.setProperty('--c', barColor(v, invert));
  };
  set('bar-hunger', p.hunger, true);
  set('bar-mood', p.mood, false);
  set('bar-energy', p.energy, false);
  const a = view.affection;
  const prog = a.next ? ` · 距「${a.nextName}」${a.need}` : ' · 已满级';
  $('meta').textContent = `${p.name} · ${view.species.nameZh} · ${a.stageName} ♥${a.value}${prog}`;
  $('pet-body').style.setProperty('--accent', view.species.accent);
  $('meta').title = `好感 ${a.value} / ${a.max}（今天 +${a.today} / ${a.dailyCap}）${view.space ? ` · 放在：${view.space.name}` : ''}`;
  // 💗 affection: stage name in its colour, the 0..100 bar and the number; the tooltip has the stage progress
  $('aff-stage').textContent = a.stageName;
  $('aff-stage').style.setProperty('--sc', a.color);
  $('bar-affection').style.setProperty('--v', `${a.value}%`);
  $('bar-affection').style.setProperty('--c', a.color);
  $('aff-num').textContent = `♥${a.value}/${a.max}`;
  $('aff-row').title = a.next ? `好感 ${a.value} / ${a.max} · 距「${a.nextName}」还差 ${a.need}（本阶段进度 ${a.pct}%）` : `好感 ${a.value} / ${a.max} · 已满级`;
  $('aff-row').setAttribute('aria-label', $('aff-row').title);
  // one look and nothing to change into (a single VRM model): no wardrobe to open
  const oneLook = view.outfits.length <= 1;
  $('btn-wardrobe').classList.toggle('hidden', oneLook);
  if (oneLook && panelKind === 'wardrobe') closePanel();
  $('btn-wardrobe').querySelector('.new-dot').classList.toggle('hidden', !view.outfits.some((o) => o.isNew));
  $('btn-topics').querySelector('.new-dot').classList.toggle('hidden', !view.topics.some((o) => o.isNew));
  setSettings(view.settings);
  $('menu-adult').textContent = !settings.ageConfirmed ? '成人向内容：关（需年满 18 岁）' : `成人向内容：${settings.adultContent ? '开（点此关闭）' : '关（点此开启）'}`;
  const loc = view.local && view.local.enabled;
  $('menu-local').textContent = `本机能力：${loc ? '开（点此关闭）' : '关（点此开启）'}`;
  if (panelKind) renderPanel();
}

// ---------- affection feedback (design 9.3, 9.4) ----------
const BLOCK_NOTES = { cooldown: '刚刚已经很开心了', cap: '今天的好感攒满啦，明天见', daily: '这个今天已经做够啦', 'topic-today': '今天聊过这个了' };

function floatText(text, cls = '') {
  const el = document.createElement('div');
  el.className = `float ${cls}`;
  el.textContent = text;
  $('float-layer').appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function onAffection(e) {
  if (e.type === 'gain') {
    if (e.delta > 0) { floatText(`+${e.delta} ♥`); fx.burst(Math.min(10, 3 + Math.round(e.delta * 2))); }
    else if (e.delta < 0) floatText(`${e.delta} ♥`, 'minus');
    else if (BLOCK_NOTES[e.blocked] && !notedBlocks.has(e.blocked)) {
      notedBlocks.add(e.blocked);
      floatText(BLOCK_NOTES[e.blocked], 'note');
    }
  } else if (e.type === 'decay') {
    floatText(`${e.delta} ♥（好久不见）`, 'minus');
  } else if (e.type === 'stage-up') {
    flashUntil = performance.now() + 700;
    if (e.view) { view = e.view; applyArt(); refreshHud(); }
    fx.play('evolve', Fx.oneShotMs(isVideo(view.pet.speciesId), 'evolve'));
    fx.burst(12);
    showUnlockToast(e);
  }
}

// A stage-up names everything it unlocked, and stays until closed (or for half a minute). A kind with
// nothing new (e.g. outfits, for a character with only her signature one) is left out.
function showUnlockToast(e) {
  const a = (e.view || view).affection;
  const names = (list) => list.map((x) => `「${x.label}」`).join('、');
  $('unlock-toast').classList.remove('notice');
  $('toast-open').classList.remove('hidden');
  $('toast-open').dataset.scroll = '';
  $('toast-title').textContent = `🎉 关系升级：${a.stageName}（♥${a.value}）`;
  const body = $('toast-body');
  body.innerHTML = '';
  for (const [k, list] of [['解锁话题', e.unlocks && e.unlocks.topics], ['解锁服饰', e.unlocks && e.unlocks.outfits]]) {
    if (!list || !list.length) continue;
    const line = document.createElement('div');
    line.innerHTML = '<b></b>';
    line.querySelector('b').textContent = `${k}：`;
    line.appendChild(document.createTextNode(names(list)));
    body.appendChild(line);
  }
  const outfits = !!(e.unlocks && e.unlocks.outfits && e.unlocks.outfits.length);
  $('toast-open').dataset.panel = outfits ? 'wardrobe' : 'topics';
  $('toast-open').textContent = outfits ? '去衣柜看看' : '去聊聊新话题';
  $('unlock-toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 30000);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('unlock-toast').classList.add('hidden');
}

// ---------- wardrobe and topics (design 9.5, 9.6) ----------
// The same look the pet shows when wearing the outfit (Dafeiyu's signature outfit is its idle clip).
const outfitArt = (o, speciesId) => lookEl(o.look, { className: 'look', alt: o.label, speciesId });

function panelMsg(text, ok = false) {
  const m = $('panel-msg');
  m.textContent = text;
  m.classList.toggle('ok', ok);
  m.classList.toggle('hidden', !text);
}

async function openPanel(kind) {
  if (thinking) return;
  $('food-menu').classList.add('hidden');
  $('main-menu').classList.add('hidden');
  $('chat-row').classList.add('hidden');
  hideToast();
  panelKind = kind;
  charDetail = null; // 角色列表 opens on the list
  const list = kind === 'wardrobe' ? view.outfits : kind === 'topics' ? view.topics : [];
  panelNew = new Set(list.filter((x) => x.isNew).map((x) => x.id));
  window.pet.panel(true);
  panelMsg('');
  $('panel').classList.remove('hidden');
  renderPanel();
  $('panel-body').scrollTop = 0; // every panel opens at its top, not where the previous one was scrolled to
  if (kind === 'wardrobe' || kind === 'topics') await window.pet.markSeen(kind === 'wardrobe' ? 'outfit' : 'topic');
}

function closePanel() {
  if (!panelKind) return;
  panelKind = null;
  $('panel').classList.add('hidden');
  window.pet.panel(false);
}

function progressLine() {
  const a = view.affection;
  return `${a.stageName} ♥${a.value}/${a.max}${a.next ? ` · 距「${a.nextName}」还差 ${a.need}` : ' · 已满级'}`;
}

function renderPanel() {
  if (panelKind === 'wardrobe') renderWardrobe();
  else if (panelKind === 'topics') renderTopics();
  else if (panelKind === 'advanced') renderAdvanced();
  else if (panelKind === 'characters') renderCharacters();
  else if (panelKind === 'history') window.PetHistory.render({ $, api: window.pet, panelMsg, isOpen: () => panelKind === 'history' });
}

// 版本与更新: the version, when it last checked, what it found, and a button to check now.
const UPDATE_REASON = { translocated: '先把应用拖进“应用程序”文件夹再打开，以后就能自动更新。', dmg: '现在是从安装盘里直接打开的，先把应用拖进“应用程序”文件夹再打开，以后就能自动更新。', 'read-only': '应用所在的文件夹不能写入，没法替换自己，请手动下载。' };
function updateStatusText(u) {
  if (!u) return '';
  return {
    disabled: '开发版（从源码运行）不会自动更新。',
    idle: '应用启动约 20 秒后会自动检查一次。',
    checking: '正在检查…',
    latest: '已经是最新版本。',
    downloading: `发现新版本 v${u.version}，正在后台下载…`,
    ready: `新版本 v${u.version} 已经下载好。离开电脑 10 分钟会自动重启更新，也可以现在就更新。`,
    manual: `有新版本 v${u.version}。${UPDATE_REASON[u.error] || '这个版本没法自动替换自己，请下载安装。'}`,
    error: `检查失败：${String(u.error || '').slice(0, 80)}。稍后会自动再试。`,
  }[u.status] || '';
}
function renderUpdateSection() {
  const sec = $('update-section');
  if (!sec || !updateState) return;
  const u = updateState;
  const when = u.checkedAt ? new Date(u.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '还没检查';
  sec.querySelector('.ver').textContent = `当前版本 v${u.current} · 上次检查：${when}`;
  const st = sec.querySelector('.st');
  st.textContent = updateStatusText(u);
  st.dataset.status = u.status;
  const check = sec.querySelector('#update-check');
  check.disabled = ['checking', 'downloading', 'disabled'].includes(u.status);
  check.textContent = u.status === 'checking' ? '正在检查…' : '检查更新';
  const go = sec.querySelector('#update-go');
  go.classList.toggle('hidden', !['ready', 'manual'].includes(u.status));
  go.textContent = u.status === 'ready' ? `立即更新到 v${u.version} 并重启` : `下载 v${u.version}`;
}
function updateSection() {
  const sec = document.createElement('div');
  sec.className = 'adv-section';
  sec.id = 'update-section';
  sec.innerHTML = '<h3>版本与更新</h3><p class="adv-text ver"></p><p class="adv-text st" role="status" aria-live="polite"></p><div class="size-row"><button id="update-check" class="btn">检查更新</button><button id="update-go" class="btn primary hidden"></button></div><p class="adv-note">自动更新：启动后检查一次，之后每 4 小时检查；新版本在后台下载，下载好后离开电脑 10 分钟会自动重启更新，退出应用时也会安装。</p>';
  sec.querySelector('#update-check').addEventListener('click', () => window.pet.checkUpdate());
  sec.querySelector('#update-go').addEventListener('click', () => window.pet.installUpdate());
  return sec;
}

let modelsRequested = false; // the model list is loaded once when a character's page first needs it
let charDetail = null; // ⋯ → 角色列表: the character whose page is open (null: the list)
let roleDraft = null; // { id, value }: unsaved 个性化设定 text (kept across panel re-renders)
const charName = (c) => (c.met && c.met.name !== c.nameZh ? `「${c.met.name}」${c.nameZh}（${c.vendor}）` : `${c.nameZh}（${c.vendor}）`);
const charRel = (c) => (c.met ? `已认识 · ${c.met.stage} · 好感 ${Math.round(c.met.affection)}` : '未见过');
// Her picture in the list and on her page: her chosen pack in the outfit she wears (daily if not met);
// `data-look` names the pack ('clips' for Dafeiyu's own clips).
function charThumb(c, large = false) {
  const box = document.createElement('div');
  box.className = `char-thumb${large ? ' lg' : ''}`;
  box.dataset.look = c.look ? c.look.packId : 'clips';
  box.appendChild(lookEl(c.look, { className: 'look', alt: c.nameZh, speciesId: c.id }));
  return box;
}
// Switch to her, or meet her for the first time (name her first).
function charPick(c, row) {
  const pick = document.createElement('button');
  pick.className = 'btn pick';
  pick.setAttribute('role', 'radio');
  pick.textContent = c.current ? '✓ 当前' : c.met ? '切换' : '初次见面';
  pick.setAttribute('aria-checked', String(c.current));
  pick.disabled = c.current;
  pick.addEventListener('click', (e) => { e.stopPropagation(); if (c.met) switchCharacter(c); else askName(row, c); });
  return pick;
}

// ⋯ → 角色列表: every character with her picture, name, title and how well you know her. A click opens her
// page (renderCharacter), where her own settings live; 切换 / 初次见面 work right here as well.
function renderCharacters() {
  const c = charDetail && view.characters.find((x) => x.id === charDetail);
  if (c) return renderCharacter(c);
  charDetail = null;
  $('panel-title').textContent = '角色列表';
  $('panel-sub').textContent = `现在是「${view.species.nameZh}」（${view.species.vendor}）· ${progressLine()}`;
  const body = $('panel-body');
  body.innerHTML = '';
  // who the companion is: every character has her own agent, chat history, name and affection
  const who = document.createElement('div');
  who.className = 'adv-section';
  who.innerHTML = '<h3>角色</h3><p class="adv-text">每位模型娘都有自己的 LobeHub agent、聊天记录、名字和好感度，换走再换回来都还在。第一次见面时给她起个名字，会在 LobeHub 里为她新建一个 agent。点角色打开她的设置：模型、个性化设定、外观和好感度。</p><div class="char-list" role="radiogroup" aria-label="角色"></div>';
  for (const ch of view.characters) {
    const row = document.createElement('div');
    row.className = `pack-opt char-opt${ch.current ? ' on' : ''}${ch.met ? ' met' : ' new'}`;
    row.dataset.species = ch.id;
    row.style.setProperty('--accent', ch.accent);
    row.innerHTML = '<div class="meta"><b></b><span></span><em class="char-rel"></em></div><button class="btn char-open" aria-label="角色设置">设置 ›</button>';
    row.prepend(charThumb(ch));
    row.querySelector('b').textContent = charName(ch);
    row.querySelector('span').textContent = ch.title;
    row.querySelector('.char-rel').textContent = charRel(ch);
    row.insertBefore(charPick(ch, row), row.querySelector('.char-open'));
    row.addEventListener('click', (e) => { if (!e.target.closest('.pick')) openCharacter(ch.id); });
    who.querySelector('.char-list').appendChild(row);
    if (naming && naming.id === ch.id && !ch.met) askName(row, ch, naming.value);
  }
  body.appendChild(who);
}

function openCharacter(id) {
  charDetail = id;
  if (naming && naming.id !== id) naming = null;
  panelMsg('');
  renderPanel();
  $('panel-body').scrollTop = 0;
}

// A character's page: who she is, and the settings that are hers alone (kept per character in
// settings.json / pet.json): the model her agent runs on, how she looks, and her affection.
function renderCharacter(c) {
  const sp = speciesOf(c.id) || {};
  $('panel-title').textContent = c.met ? c.met.name : c.nameZh;
  $('panel-sub').textContent = `${c.nameZh}（${c.vendor}）· ${c.current ? '当前陪伴' : c.met ? '已认识' : '未见过'}${c.met ? ` · ${c.met.stage} ♥${Math.round(c.met.affection)}` : ''}`;
  const body = $('panel-body');
  body.innerHTML = '';

  const back = document.createElement('div');
  back.className = 'size-row char-back-row';
  back.innerHTML = '<button id="char-back" class="btn">‹ 角色列表</button>';
  back.querySelector('#char-back').addEventListener('click', () => { charDetail = null; naming = null; roleDraft = null; panelMsg(''); renderPanel(); });
  body.appendChild(back);

  // who she is, and 切换 / 初次见面
  const head = document.createElement('div');
  head.className = 'adv-section char-head';
  head.id = 'char-head';
  head.style.setProperty('--accent', c.accent);
  head.innerHTML = '<div class="pack-opt char-opt"><div class="meta"><b></b><span></span><em class="char-rel"></em><small class="adv-note"></small></div></div>';
  const row = head.querySelector('.char-opt');
  row.classList.toggle('on', c.current);
  row.classList.add(c.met ? 'met' : 'new');
  row.dataset.species = c.id;
  row.prepend(charThumb(c, true));
  row.querySelector('b').textContent = charName(c);
  row.querySelector('span').textContent = c.title;
  row.querySelector('.char-rel').textContent = charRel(c);
  row.querySelector('small').textContent = sp.blurb || '';
  row.appendChild(charPick(c, row));
  body.appendChild(head);
  if (naming && naming.id === c.id && !c.met) askName(row, c, naming.value);

  // the model her agent runs on: only her own vendor's models (src/characters/<id>.json `models`)
  const mod = document.createElement('div');
  mod.className = 'adv-section';
  mod.id = 'model-section';
  const m = c.model;
  mod.innerHTML = '<h3>模型</h3><p class="adv-text"></p><div class="size-row"><select id="model-select" aria-label="模型"></select><button id="model-refresh" class="btn">刷新</button></div><p class="adv-text model-status"></p>';
  mod.querySelector('.adv-text').textContent = `${c.nameZh}只能用 ${c.vendor} 的模型，每位角色各记各的。列表来自你在 LobeHub 里启用的模型。`;
  const sel = mod.querySelector('#model-select');
  for (const o of m.options) {
    const opt = document.createElement('option');
    opt.value = o.key;
    opt.textContent = o.hosted ? o.label : `${o.label}（自己的 ${c.vendor} Key）`;
    opt.selected = o.key === m.current;
    sel.appendChild(opt);
  }
  sel.disabled = !m.options.length;
  const now = m.options.find((o) => o.key === m.current);
  const pending = c.current ? '下一句话起用' : c.met ? '她下次陪你时起用' : '见面后起用';
  mod.querySelector('.model-status').textContent = !m.loaded
    ? (m.error ? `读不到模型列表（${m.error.slice(0, 60)}），她先用原来的模型。` : '正在读取模型列表…')
    : !now ? `你没有启用任何 ${c.vendor} 模型，她先用原来的模型。`
      : `${m.applied === m.current ? '正在用' : pending}：${now.label}${m.chosen ? '' : '（默认）'}`;
  sel.addEventListener('change', async () => {
    const r = await window.pet.setModel(sel.value, c.id);
    if (!r.ok) return panelMsg('这个模型现在不能选，点“刷新”再试试。');
    view = r.view;
    renderPanel();
    const nc = view.characters.find((x) => x.id === c.id);
    panelMsg(`${c.nameZh}的模型已换成「${(nc.model.options.find((o) => o.key === nc.model.current) || {}).label}」。`, true);
  });
  mod.querySelector('#model-refresh').addEventListener('click', async () => {
    const r = await window.pet.refreshModels();
    view = r.view;
    renderPanel();
  });
  if (!m.loaded && !m.error && !modelsRequested) {
    modelsRequested = true;
    window.pet.refreshModels().then((r) => { view = r.view; if (panelKind === 'characters') renderPanel(); });
  }
  body.appendChild(mod);

  // 个性化设定: the owner's own words added to her agent's system role (settings.systemRoles[id])
  const role = document.createElement('div');
  role.className = 'adv-section';
  role.id = 'role-section';
  const max = (settings && settings.systemRoleMax) || 1000;
  role.innerHTML = '<h3>个性化设定（System Role）</h3><p class="adv-text"></p><textarea id="role-input" rows="5" aria-label="个性化设定"></textarea><div class="size-row role-row"><span class="adv-note role-count"></span><button id="role-clear" class="btn">清空</button><button id="role-save" class="btn primary">保存</button></div><p class="adv-text role-status"></p>';
  role.querySelector('.adv-text').textContent = `写给${c.nameZh}的额外设定，比如怎么称呼你、说话风格、要记住的事。会加进她的 agent 设定里，只对她生效；关系阶段和内容红线仍然优先。`;
  const input = role.querySelector('#role-input');
  input.maxLength = max;
  input.placeholder = `例如：叫我“老板”；说话多用比喻；我是前端工程师，聊技术时可以说得专业一点。`;
  input.value = roleDraft && roleDraft.id === c.id ? roleDraft.value : c.systemRole || '';
  const count = role.querySelector('.role-count');
  const save = role.querySelector('#role-save');
  const clear = role.querySelector('#role-clear');
  const sync = () => {
    count.textContent = `${input.value.length}/${max}`;
    save.disabled = input.value.trim() === (c.systemRole || '');
    clear.disabled = !input.value;
  };
  sync();
  input.addEventListener('input', () => { roleDraft = { id: c.id, value: input.value }; sync(); });
  role.querySelector('.role-status').textContent = c.systemRole
    ? `已保存${c.current ? '，下一句话起用' : c.met ? '，她下次陪你时起用' : '，见面后起用'}。`
    : '还没写，她按默认性格来。';
  const apply = async (text) => {
    const r = await window.pet.setSystemRole(text, c.id);
    if (!r.ok) return panelMsg(r.reason === 'too-long' ? `最多 ${max} 个字。` : '现在保存不了，稍后再试。');
    roleDraft = null;
    view = r.view;
    renderPanel();
    panelMsg(text.trim() ? `${c.nameZh}的个性化设定已保存。` : `${c.nameZh}的个性化设定已清空。`, true);
  };
  save.addEventListener('click', () => apply(input.value));
  clear.addEventListener('click', () => {
    if (!c.systemRole) { input.value = ''; roleDraft = null; return sync(); }
    if (confirm(`清空${c.nameZh}的个性化设定？`)) apply('');
  });
  body.appendChild(role);

  // appearance: which pet pack dresses her; packs can be imported from a folder or .zip
  const look = document.createElement('div');
  look.className = 'adv-section';
  look.id = 'look-section';
  look.innerHTML = '<h3>外观（角色包）</h3><p class="adv-text">选择她的画风。角色包只提供图片，解锁条件不受角色包影响；标着 18+ 的成年版只在确认已满 18 岁并打开成人向内容后列出，成人向服饰只在穿成年版时出现。格式见项目里的 docs/pet-packs.md。</p><div class="pack-list" role="radiogroup" aria-label="外观"></div><div class="size-row"><button id="pack-import" class="btn">导入角色包…</button><button id="pack-folder" class="btn">打开角色包文件夹</button></div><p class="adv-text l2d-text">也可以直接用你自己的 Live2D 模型（Cubism 3 / 4 / 5，选它的 .model3.json 或打包好的 .zip）：她会用模型自己的物理，表情、眨眼、口型和动作由应用驱动，所有全年龄服饰下都穿这个模型。</p><div class="size-row"><button id="l2d-import" class="btn">导入 Live2D 模型…</button></div><p class="adv-text vrm-text">或者导入 VRM 3D 模型（VRM 1.0 / 0.x 的 .vrm 文件）：作者和授权从模型文件里读出并显示在这里，应用按授权限制使用（不可再分发的模型不能导出，不允许性表现的模型不能用于 18+ 内容）。模型只复制到本机的用户数据目录。</p><div class="size-row"><button id="vrm-import" class="btn">导入 VRM 模型…</button></div>';
  const list = look.querySelector('.pack-list');
  for (const o of c.appearance.options) {
    const on = o.id === c.appearance.packId;
    const prow = document.createElement('div');
    prow.className = `pack-opt${on ? ' on' : ''}`;
    prow.dataset.pack = o.id;
    prow.innerHTML = '<button class="btn pick" role="radio"></button><div class="meta"><b></b><span></span></div>';
    if (o.kind === 'vrm') prow.classList.add('vrm');
    const pick = prow.querySelector('.pick');
    pick.textContent = on ? '✓ 使用中' : '使用';
    pick.setAttribute('aria-checked', String(on));
    pick.disabled = on;
    prow.querySelector('b').textContent = o.name;
    prow.querySelector('span').textContent = window.PetVrmUi.packMetaLine(o);
    const credit = o.kind === 'vrm' && window.PetVrmUi.creditLine(o.vrm);
    if (credit) {
      // the license asks for credit: the author stays on the card, not only in the details
      const cr = document.createElement('small');
      cr.className = 'vrm-credit';
      cr.textContent = credit;
      prow.querySelector('.meta').appendChild(cr);
    }
    pick.addEventListener('click', async () => {
      const r = await window.pet.setAppearance(o.id, c.id);
      if (!r.ok) return;
      view = r.view;
      applyArt();
      renderPanel();
      panelMsg(`${c.nameZh}的外观已换成「${o.name}」。`, true);
    });
    // a VRM card has more to offer (授权信息, 导出…): its buttons get a row of their own under the meta
    const actions = o.kind === 'vrm' ? document.createElement('div') : prow;
    if (o.kind === 'vrm') { actions.className = 'pack-actions'; prow.appendChild(actions); }
    if (o.kind === 'vrm' && o.vrm) {
      const info = document.createElement('button');
      info.className = 'btn vrm-info';
      info.textContent = '授权信息';
      info.setAttribute('aria-expanded', String(vrmOpen.has(o.id)));
      info.addEventListener('click', () => {
        if (vrmOpen.has(o.id)) vrmOpen.delete(o.id); else vrmOpen.add(o.id);
        renderPanel();
      });
      actions.appendChild(info);
    }
    if (o.source === 'user') {
      // 导出…: a .zip of the pack; refused (and the reason shown) when the model may not be redistributed
      const ex = document.createElement('button');
      ex.className = 'btn pack-export';
      ex.textContent = '导出…';
      const can = window.PetVrmUi.exportState(o);
      if (!can.ok) {
        ex.disabled = true;
        ex.title = can.text;
        ex.setAttribute('aria-description', can.text);
      }
      ex.addEventListener('click', async () => {
        const r = await window.pet.exportPack(o.id);
        if (r.reason === 'canceled') return;
        panelMsg(r.ok ? `已导出「${o.name}」到 ${r.file}` : `不能导出：${r.text || r.reason}`, !!r.ok);
      });
      actions.appendChild(ex);
    }
    if (o.source === 'user') {
      const del = document.createElement('button');
      del.className = 'btn pack-remove';
      del.textContent = '移除';
      del.addEventListener('click', async () => {
        if (!confirm(`移除角色包「${o.name}」？`)) return;
        await window.pet.removePack(o.id);
      });
      actions.appendChild(del);
    }
    list.appendChild(prow);
    if (o.kind === 'vrm' && o.vrm) {
      const can = window.PetVrmUi.exportState(o);
      if (o.source === 'user' && !can.ok) {
        const why = document.createElement('p');
        why.className = 'adv-note vrm-noexport';
        why.dataset.pack = o.id;
        why.textContent = `🚫 导出已禁用：${can.text}`;
        list.appendChild(why);
      }
      if (vrmOpen.has(o.id)) list.appendChild(vrmLicenseBox(o.vrm, o.id));
    }
  }
  look.querySelector('#pack-import').addEventListener('click', async () => {
    const r = await window.pet.importPack();
    if (r.reason === 'canceled') return;
    if (!r.ok) return panelMsg(`导入失败：${(r.errors || []).slice(0, 3).join('；')}`);
    panelMsg(r.pack.species === c.id ? `已导入「${r.pack.name}」，点“使用”换上。` : `已导入「${r.pack.name}」（给 ${(speciesOf(r.pack.species) || {}).nameZh || r.pack.species} 用的）。`, true);
  });
  look.querySelector('#pack-folder').addEventListener('click', () => window.pet.openPacksFolder());
  look.querySelector('#l2d-import').addEventListener('click', () => importLive2d(c));
  look.querySelector('#vrm-import').addEventListener('click', () => importVrm(c));
  // an imported Live2D model in use: how much of the window she fills
  const mine = c.appearance.options.find((o) => o.id === c.appearance.packId && o.kind === 'live2d' && o.source === 'user');
  if (mine) {
    const row = document.createElement('div');
    row.className = 'size-row l2d-size';
    row.innerHTML = '<span>模型大小</span><input type="range" min="30" max="100" step="5" aria-label="Live2D 模型大小"><b></b>';
    const range = row.querySelector('input');
    const label = row.querySelector('b');
    range.value = String(Math.round(mine.height * 100));
    label.textContent = `${range.value}%`;
    range.addEventListener('input', () => { label.textContent = `${range.value}%`; });
    range.addEventListener('change', async () => {
      const r = await window.pet.setLive2dHeight(mine.id, Number(range.value) / 100);
      if (!r.ok) panelMsg('没能保存模型大小。');
    });
    look.appendChild(row);
  }
  body.appendChild(look);

  // affection: unlock everything at once (to see all the content, or to skip the grind) — hers only
  const sec = document.createElement('div');
  sec.className = 'adv-section';
  sec.id = 'unlock-section';
  sec.innerHTML = '<h3>好感度 · 一键解锁</h3><p class="adv-text"></p><p class="adv-note"></p><button id="unlock-all" class="btn primary"></button>';
  const a = c.met && c.met.progress;
  const all = !!a && !a.next && a.value >= a.max;
  sec.querySelector('.adv-text').textContent = `直接把${c.nameZh}的好感度加满（♥100），她的所有关系阶段、话题和服饰立刻解锁。适合想先看看全部内容、或者不想慢慢攒好感的玩家。只作用于她，不影响其他角色。解锁后不能撤销，之后的互动照常计分。`;
  sec.querySelector('.adv-note').textContent = !c.met ? `还没认识${c.nameZh}：先点上面的“初次见面”请她来，才有好感度可以解锁。` : settings && settings.adultContent ? '成人向话题和服饰会一起解锁。' : '成人向话题和服饰只在确认年满 18 岁并开启“成人向内容”（⋯ 菜单）后出现；没开启时只解锁全年龄内容。';
  const btn = sec.querySelector('#unlock-all');
  btn.textContent = !c.met ? '还没认识她' : all ? '已经全部解锁' : `解锁${c.nameZh}的全部好感度和服饰`;
  btn.disabled = !c.met || all;
  btn.addEventListener('click', () => unlockAllNow(c));
  body.appendChild(sec);
}

// 外观 → 导入 Live2D 模型…: main copies the model into a new pack; here it is drawn once off-screen for its
// picture (lists, the wardrobe) and then worn. A model that will not load here is removed again.
const FACE_NAMES = { blush: '脸红', wide: '惊讶', squint: '眯眼', gloom: '阴沉', dizzy: '晕', drool: '口水' };
async function importLive2d(c) {
  const r = await window.pet.importLive2d(c.id);
  if (r.reason === 'canceled') return;
  if (!r.ok) return panelMsg(`导入失败：${(r.errors || []).slice(0, 3).join('；')}`);
  panelMsg(`正在加载「${r.pack.name}」…`, true);
  let png;
  try {
    png = await live2dPicture(r.model);
  } catch (e) {
    await window.pet.removePack(r.pack.id);
    return panelMsg(`导入失败：这个模型在这台电脑上加载不了（${(e && e.message) || e}）。`);
  }
  await window.pet.savePackPreview(r.pack.id, png);
  const s = await window.pet.setAppearance(r.pack.id, c.id);
  if (s.ok) {
    view = s.view;
    applyArt();
    renderPanel();
  }
  const faces = (r.faces || []).map((f) => FACE_NAMES[f] || f);
  panelMsg(`已导入 Live2D 模型「${r.pack.name}」并换上${faces.length ? `，用上了它的表情：${faces.join('、')}` : ''}。`, true);
}
// 外观 → 导入 VRM 模型…: main checks the file (glTF + VRM extension), reads its meta and license from the
// model and copies it into a new user pack. Before she wears it, 导入确认 shows who made the model and what
// its license allows; 取消导入 removes the pack again. The license details stay one click away on the card.
const vrmOpen = new Set(); // VRM pack ids whose 授权信息 is open in the list
async function importVrm(c) {
  const r = await window.pet.importVrm(c.id);
  if (r.reason === 'canceled') return;
  if (!r.ok) return panelMsg(window.PetVrmUi.importErrorText(r.errors));
  panelMsg(`已导入「${r.pack.name}」，请确认授权信息。`, true);
  // the picture for lists and the wardrobe, when the 3D renderer is there to draw one
  if (window.PetVRM && window.PetVRM.picture) {
    try { await window.pet.savePackPreview(r.pack.id, await window.PetVRM.picture(r.model)); } catch (e) { console.warn('[vrm] no picture:', e && e.message); }
  }
  const use = await vrmConfirm(r);
  if (!use) {
    await window.pet.removePack(r.pack.id);
    return panelMsg(`已取消导入「${r.pack.name}」，模型没有留在本机的角色包里。`, true);
  }
  const s = await window.pet.setAppearance(r.pack.id, c.id);
  if (s.ok) {
    view = s.view;
    applyArt();
    renderPanel();
  }
  panelMsg(`已导入 VRM 模型「${r.pack.name}」并换上（作者：${r.license.author}）。`, true);
}
// 导入确认: the model's meta and the restrictions of its license; resolves true for 使用这个模型.
function vrmConfirm(r) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'vrm-confirm';
    box.id = 'vrm-confirm';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'vrm-confirm-title');
    box.innerHTML = '<div class="vrm-confirm-card"><h3 id="vrm-confirm-title"></h3><p class="adv-note"></p><div class="vrm-confirm-body"></div><div class="size-row vrm-confirm-actions"><button class="btn" data-act="cancel">取消导入</button><button class="btn primary" data-act="use">使用这个模型</button></div></div>';
    box.querySelector('h3').textContent = `导入 VRM 模型「${r.pack.name}」`;
    box.querySelector('.adv-note').textContent = `${r.outfits.length} 套全年龄服饰都会穿这个模型。以下信息读自模型文件，应用会按授权限制使用；点“使用这个模型”即表示你确认有权在本机使用它。`;
    box.querySelector('.vrm-confirm-body').appendChild(vrmLicenseBox({ ...r.license, models: [{ file: '', meta: r.meta, restrictions: r.license.restrictions }] }, r.pack.id, true));
    const done = (v) => { box.remove(); resolve(v); };
    box.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
    box.querySelector('[data-act="use"]').addEventListener('click', () => done(true));
    document.body.appendChild(box);
    box.querySelector('[data-act="use"]').focus();
  });
}
// The license of a VRM pack: the restrictions (what the app enforces first), then per model its meta.
function vrmLicenseBox(vrm, packId, inDialog = false) {
  const U = window.PetVrmUi;
  const box = document.createElement('div');
  box.className = 'vrm-license';
  box.dataset.pack = packId;
  const h = document.createElement('div');
  h.className = 'vrm-summary';
  h.textContent = vrm.summary || '';
  box.appendChild(h);
  const rs = U.restrictionList(vrm.restrictions);
  if (rs.length) {
    const ul = document.createElement('ul');
    ul.className = 'vrm-restrictions';
    ul.setAttribute('aria-label', '授权限制');
    for (const x of rs) {
      const li = document.createElement('li');
      li.className = `tone-${x.tone}`;
      li.dataset.id = x.id;
      li.textContent = x.text;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  for (const m of vrm.models || []) {
    const dl = document.createElement('dl');
    dl.className = 'vrm-meta';
    if (!inDialog && (vrm.models || []).length > 1) dl.dataset.file = m.file;
    for (const row of U.licenseRows(m.meta)) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      if (row.href) {
        const a = document.createElement('a');
        a.href = row.href;
        a.textContent = row.text;
        a.title = '在浏览器中打开';
        a.addEventListener('click', (e) => { e.preventDefault(); window.pet.openLink(row.href); });
        dd.appendChild(a);
      } else dd.textContent = row.text;
      dl.append(dt, dd);
    }
    box.appendChild(dl);
  }
  return box;
}
async function live2dPicture(model) {
  const c = document.createElement('canvas');
  c.width = 332;
  c.height = 452;
  const figure = window.PetLive2D.createFigure(c, { kind: 'live2d', model, live2d: { height: 0.8 } });
  try {
    if ((await figure.ready) !== true) throw new Error('模型没有加载出来');
    for (let i = 0; i < 30; i++) figure.draw({ t: i / 30, state: 'idle', blink: 0 }); // let the physics settle
    return c.toDataURL('image/png');
  } finally {
    figure.dispose();
  }
}

// ⋯ → 高级设置: what applies to the whole app, whoever the companion is (size, behaviour, voice engines,
// visitors, local API, updates). Per-character settings (model, look, affection) are on her page in 角色列表.
function renderAdvanced() {
  $('panel-title').textContent = '高级设置';
  $('panel-sub').textContent = '对所有角色生效。模型、个性化设定、外观和好感度在 ⋯ → 角色列表里按角色设置。';
  const body = $('panel-body');
  body.innerHTML = '';
  const size = document.createElement('div');
  size.className = 'adv-section';
  size.innerHTML = '<h3>宠物大小 <span class="size-val"></span></h3><p class="adv-text">拖动滑块调整桌面上角色的大小（50%–250%），窗口跟着变，右下角保持不动。在桌面上也能直接调：悬停时拖左上角的 ⤡ 手柄，或按住 Ctrl/⌘ 滚动滚轮。</p><div class="size-row"><input id="size-range" type="range" aria-label="宠物大小" /><button id="size-reset" class="btn"></button></div>';
  const range = size.querySelector('#size-range');
  const r = settings.petScaleRange;
  range.min = String(r.min * 100);
  range.max = String(r.max * 100);
  range.step = '5';
  range.value = String(Math.round(settings.petScale * 100));
  const defaultPct = `${Math.round(r.default * 100)}%`;
  size.querySelector('#size-reset').textContent = `恢复默认 ${defaultPct}`;
  const label = () => { size.querySelector('.size-val').textContent = `${range.value}%`; };
  label();
  range.addEventListener('input', label);
  range.addEventListener('change', async () => {
    await commitScale(Number(range.value) / 100);
    range.value = String(Math.round(settings.petScale * 100));
    label();
    panelMsg(`宠物大小：${range.value}%。关掉这个面板就能看到效果。`, true);
  });
  size.querySelector('#size-reset').addEventListener('click', async () => {
    await commitScale(r.default);
    renderAdvanced();
    panelMsg(`宠物大小已恢复为默认的 ${defaultPct}。`, true);
  });
  body.appendChild(size);
  for (const el of behaviorSections()) body.appendChild(el);
  body.appendChild(updateSection());
  renderUpdateSection();
}

// 高级设置 → 桌宠行为 / 同屏伙伴 / 对外接口: the desktop effects ported from dsh-pet.
const PREF_LABELS = [
  ['roam', '自己走动', '空闲时偶尔朝面向的方向走几步（平均约 100 秒一次，每次 60–240 像素，到屏幕边会掉头）。鼠标停在她身上、她在忙或开着面板时不走。关掉后她只在原地待机和做小动作。'],
  ['clickSound', '点击音效', '点她时“啵”一声（100 毫秒内连点只响一次）。'],
  ['voice', '朗读回复', '把她的回复和对外接口发来的话念出来，用下面“语音”里选的引擎和她自己的音色。引擎用不了时改用系统语音（系统没有中文语音时不出声）。关掉后完全不出声，也不再请求任何语音。'],
  ['voiceInteractions', '互动语音', '开着“朗读回复”时，摸头、部位触摸、喂食、玩耍、哄睡、拖拽、甩出、接住、初次见面、关系升级和切换角色也念出她的台词。常用短句会提前合成好缓存起来，点了马上就响；连点时上一句没说完不会插新的一句，1.5 秒内也只说一句。'],
  ['voiceMurmurs', '朗读碎碎念', '开着“朗读回复”时，她自己冒出来的话（饿了、无聊、早晚问候、想你了、睡醒）也念出来。默认不念。'],
  ['memes', '梗图', '她偶尔在气泡里配一张自己的表情包（回复由 agent 自己挑，碎碎念随机）。'],
  ['collide', '互相碰撞', '桌面上有同屏伙伴时，被甩出去的她会把撞到的伙伴弹开。'],
  ['touchZones', '部位触摸', '点她的头、胸、手、臀、脚等不同部位，她的反应和台词都不一样；乱碰会生气、扣好感。关掉后点哪里都只是摸摸她。'],
  ['touchHint', '触摸提示', '鼠标停在她身上时，在指针旁标出这里是哪个部位（需开着“部位触摸”）。'],
];
function behaviorSections() {
  const st = settings;
  const beh = document.createElement('div');
  beh.className = 'adv-section';
  beh.id = 'behavior-section';
  beh.innerHTML = '<h3>桌宠行为</h3><p class="adv-note">这些效果所有角色都有，只是素材和声音不同。也能拖着她甩出去、双击后拉开当弹弓、在她飞的时候点中她得分；触屏上长按她打开菜单。</p>';
  for (const [k, label, desc] of PREF_LABELS) {
    const row = document.createElement('label');
    row.className = 'pref-row';
    row.innerHTML = '<input type="checkbox" /><span><b></b><small></small></span>';
    const box = row.querySelector('input');
    box.dataset.pref = k;
    box.checked = !!st.prefs[k];
    row.querySelector('b').textContent = label;
    row.querySelector('small').textContent = desc;
    box.addEventListener('change', async () => {
      const r = await window.pet.setPrefs({ [k]: box.checked });
      setSettings(r.settings);
      panelMsg(`${label}：${box.checked ? '开' : '关'}。`, true);
    });
    beh.appendChild(row);
  }

  const vis = document.createElement('div');
  vis.className = 'adv-section';
  vis.id = 'visitor-section';
  vis.innerHTML = `<h3>同屏伙伴</h3><p class="adv-text">请其他模型娘来桌面上串门（最多 ${3} 位）。她们没有自己的 agent，不聊天、不计好感，只陪着走动、被点、被甩，打开“互相碰撞”还会被撞开。悬停在她身上点 × 送她回去。</p><div class="char-list"></div>`;
  for (const c of view.characters.filter((x) => !x.current)) {
    const row = document.createElement('label');
    row.className = 'pref-row';
    row.style.setProperty('--accent', c.accent);
    row.innerHTML = '<input type="checkbox" /><span><b></b><small></small></span>';
    const box = row.querySelector('input');
    box.dataset.visitor = c.id;
    box.checked = st.visitors.includes(c.id);
    row.querySelector('b').textContent = `${c.nameZh}（${c.vendor}）`;
    row.querySelector('small').textContent = c.title;
    box.addEventListener('change', async () => {
      const next = box.checked ? [...settings.visitors, c.id] : settings.visitors.filter((v) => v !== c.id);
      const r = await window.pet.setVisitors(next);
      setSettings(r.settings);
      if (box.checked && !r.settings.visitors.includes(c.id)) { box.checked = false; panelMsg('同屏伙伴最多 3 位。'); return; }
      panelMsg(box.checked ? `${c.nameZh}来串门了。` : `${c.nameZh}回去了。`, true);
    });
    vis.querySelector('.char-list').appendChild(row);
  }

  const api = document.createElement('div');
  api.className = 'adv-section';
  api.id = 'api-section';
  api.innerHTML = '<h3>对外接口（本机 HTTP）</h3><p class="adv-text">让本机的脚本或其他程序驱动她：说话、播动作、抛出去、和 agent 聊一句、读状态。只监听 127.0.0.1，每次调用都要带令牌（<code>Authorization: Bearer &lt;令牌&gt;</code>）。默认关闭。</p><label class="pref-row"><input type="checkbox" id="api-on" /><span><b>开启对外接口</b><small id="api-st"></small></span></label><div class="size-row"><span>端口</span><input id="api-port" type="number" min="1024" max="65535" /><button id="api-token-new" class="btn">换一个令牌</button></div><code id="api-token" class="api-token"></code><pre id="api-routes" class="api-routes"></pre>';
  const on = api.querySelector('#api-on');
  const port = api.querySelector('#api-port');
  on.checked = st.api.enabled;
  port.value = String(st.api.port);
  const paint = (status) => {
    api.querySelector('#api-token').textContent = settings.api.token ? `令牌：${settings.api.token}` : '开启时生成令牌';
    api.querySelector('#api-st').textContent = status && status.listening ? `正在监听 http://127.0.0.1:${status.port}/pixel-pet/` : status && status.error ? `没能开启：${status.error}` : '未开启';
    api.querySelector('#api-routes').textContent = ['GET  /pixel-pet/state', 'POST /pixel-pet/say    {"text":"…"}', 'POST /pixel-pet/anim   {"state":"walk"}', 'POST /pixel-pet/throw  {"angle":60,"power":1.2}', 'POST /pixel-pet/chat   {"text":"…"}'].join('\n');
  };
  const apply = async (opts) => {
    const r = await window.pet.setApi(opts);
    setSettings(r.settings);
    on.checked = r.settings.api.enabled;
    paint(r.status);
  };
  on.addEventListener('change', () => apply({ enabled: on.checked }));
  port.addEventListener('change', () => apply({ port: Number(port.value) }));
  api.querySelector('#api-token-new').addEventListener('click', () => apply({ newToken: true }));
  window.pet.apiStatus().then(paint);
  return [beh, voiceSection(), asrSection(), vis, api];
}

// 高级设置 → 语音 (core/tts.js): which engine reads, its API key and endpoint, what happens when it cannot.
// Keys are sent once to main and never shown again; only "已设置" comes back.
const TTS_ENGINES = [
  ['auto', '按角色（推荐）', '', ''],
  ['fish', 'Fish Audio', 'https://api.fish.audio', '在 fish.audio 注册后创建 API Key；开发可先用免费模型。'],
  ['minimax', 'MiniMax', 'https://api.minimax.cn', '在 platform.minimaxi.com（国内站）开通后创建接口密钥，不用 GroupId；国际站（minimax.io）的 Key 把端点改成 https://api.minimax.io。'],
  ['local', '本地语音服务（自己部署）', '', '你自己在本机或家里有显卡的电脑上跑的语音服务（IndexTTS2、GPT-SoVITS、whale-voice 等），音色由你的服务决定。填它的地址：本机用 http://127.0.0.1:端口，局域网的电脑也可以用 http://192.168.x.x:端口。“OpenAI 兼容”请求 /v1/audio/speech，要填模型和音色名；“whale-voice”请求 /tts，按她的心情选情绪。一句最多等 20 秒（长句 40 秒）。服务不要 Key 就不用填。'],
  ['system', '系统语音（离线、免费）', '', ''],
];
const TTS_NAME = { fish: 'Fish Audio', minimax: 'MiniMax', local: '本地语音服务' };
const TTS_REASON = { 'no-key': '没填 Key', 'no-endpoint': '没填地址', 'not-audio': '返回的不是音频', 'no-voice': '她在这个引擎上没有音色', timeout: '超时', network: '连不上', 'http-401': 'Key 无效', 'http-402': '余额不足', 'http-429': '请求太频繁', 'api-1002': '被限流（请求太频繁）', 'api-1039': '被限流（请求太频繁）', 'api-1008': '余额不足', 'api-2013': '请求参数有误', 'rate-limit': '这一分钟的次数用完了', empty: '没有返回音频', offline: '离线' };
const ttsReason = (r) => (r.startsWith('paused:') ? `暂停中（${ttsReason(r.slice(7))}）` : TTS_REASON[r] || (r.startsWith('http-') ? `服务出错 ${r.slice(5)}` : r.startsWith('api-') ? `接口错误 ${r.slice(4)}` : r));
const ttsWait = (sec) => (sec < 60 ? `${sec} 秒` : `${Math.ceil(sec / 60)} 分钟`);
function voiceSection() {
  const sec = document.createElement('div');
  sec.className = 'adv-section';
  sec.id = 'voice-section';
  sec.innerHTML = '<h3>语音</h3><p class="adv-text">开着“朗读回复”时用哪个引擎念。“按角色”是每个角色自己的默认引擎（大肥鱼用 MiniMax，其他角色用 Fish Audio）；她的引擎没填 Key 时，换另一个填了 Key 的引擎。云端引擎要填 API Key，Key 加密存在本机，不进日志、不会再显示；没填 Key、断网、5 秒没响应（长句最多 10 秒）或出错时，这句改用下面选的方式。MiniMax 国内站每分钟只能合成 10 次，用完了就稍等或改用下面的方式，不会被限流卡住。“本地语音服务”是你自己部署的服务，只在选它时使用，不当别的引擎的备用。合成过的句子缓存在本机，再说同一句不再请求。</p>'
    + '<div class="size-row"><span>引擎</span><select id="tts-provider"></select></div>'
    + '<div class="size-row"><span>用不了时</span><select id="tts-fallback"><option value="system">改用系统语音</option><option value="silent">不出声</option></select></div>'
    + '<label class="pref-row"><input type="checkbox" id="tts-packs" /><span><b>语音包</b><small id="tts-packs-st"></small></span></label>'
    + '<div class="size-row"><button id="tts-pack-folder" class="btn">打开语音包文件夹</button><button id="tts-pack-reload" class="btn">重新读取</button></div>'
    + '<div id="tts-engines"></div><p class="adv-note" id="tts-status"></p>'
    + '<div class="size-row"><button id="tts-clear" class="btn">清空语音缓存</button><button id="tts-test" class="btn">试听一句</button></div>'
    + '<p class="adv-note" id="tts-credit"></p>';
  const sel = sec.querySelector('#tts-provider');
  for (const [id, label] of TTS_ENGINES) sel.insertAdjacentHTML('beforeend', `<option value="${id}">${label}</option>`);
  sel.value = settings.tts.provider;
  const fb = sec.querySelector('#tts-fallback');
  fb.value = settings.tts.fallback;
  const apply = async (patch, msg) => {
    const r = await window.pet.setTts(patch);
    setSettings(r.settings);
    paintVoiceStatus();
    panelMsg(r.ok ? msg : r.reason === 'bad-key' ? '这不像一个 API Key（不能有空格，8–256 个字符）。' : '端点要是 https:// 地址（本机调试可用 http://127.0.0.1；本地语音服务也可以用局域网地址 http://192.168.x.x）。', r.ok);
    return r.ok;
  };
  sel.addEventListener('change', () => apply({ provider: sel.value }, `语音引擎：${sel.selectedOptions[0].textContent}。`));
  fb.addEventListener('change', () => apply({ fallback: fb.value }, `引擎用不了时：${fb.selectedOptions[0].textContent}。`));
  const packsBox = sec.querySelector('#tts-packs');
  packsBox.checked = settings.tts.packs !== false;
  sec.querySelector('#tts-pack-folder').addEventListener('click', () => { window.pet.openVoicePacksFolder(); panelMsg('把语音包文件夹（manifest.json + 音频）放进去，再点“重新读取”。格式见使用说明。', true); });
  sec.querySelector('#tts-pack-reload').addEventListener('click', async () => {
    const r = await window.pet.reloadVoicePacks();
    setSettings(r.settings);
    paintVoiceStatus();
    panelMsg(r.errors.length ? `有语音包没读进来：${r.errors.join(' / ')}` : '语音包已重新读取。', !r.errors.length);
  });
  packsBox.addEventListener('change', () => apply({ packs: packsBox.checked }, packsBox.checked ? '语音包已打开：固定台词直接播放录好的语音。' : '语音包已关闭：每句都交给引擎合成。'));
  for (const [id, label, def, how] of TTS_ENGINES.filter((e) => e[3])) {
    const local = id === 'local';
    const box = document.createElement('div');
    box.className = 'tts-engine';
    box.dataset.engine = id;
    box.innerHTML = '<b></b><small class="adv-note"></small>'
      + (local ? '<div class="size-row"><span>接口</span><select class="tts-local-api"><option value="openai">OpenAI 兼容（/v1/audio/speech）</option><option value="whale">whale-voice（/tts）</option></select></div>' : '')
      + '<div class="size-row"><input type="password" class="tts-key" autocomplete="off" spellcheck="false" /><button class="btn tts-key-save">保存</button><button class="btn tts-key-del">清除</button></div><div class="size-row"><input type="text" class="tts-endpoint" spellcheck="false" /><button class="btn tts-ep-save">保存端点</button></div>'
      + (local ? '<div class="size-row tts-local-names"><input type="text" class="tts-local-model" spellcheck="false" placeholder="模型（不填：tts-1）" /><input type="text" class="tts-local-voice" spellcheck="false" placeholder="音色名（不填：default）" /><button class="btn tts-local-save">保存</button></div>' : '');
    box.querySelector('b').textContent = label.replace(/（.*）/, '');
    box.querySelector('small').textContent = how;
    const key = box.querySelector('.tts-key');
    const ep = box.querySelector('.tts-endpoint');
    ep.placeholder = local ? '地址，比如 http://127.0.0.1:7864' : `端点（默认 ${def}）`;
    ep.value = settings.tts.endpoints[id] || '';
    if (local) {
      const api = box.querySelector('.tts-local-api');
      const names = box.querySelector('.tts-local-names');
      const model = box.querySelector('.tts-local-model');
      const voiceName = box.querySelector('.tts-local-voice');
      const lo = settings.tts.local || {};
      api.value = lo.api || 'openai';
      model.value = lo.model || '';
      voiceName.value = lo.voice || '';
      names.style.display = api.value === 'whale' ? 'none' : ''; // whale-voice has one voice, picked when its server starts
      api.addEventListener('change', () => { names.style.display = api.value === 'whale' ? 'none' : ''; apply({ local: { api: api.value } }, `本地语音服务接口：${api.selectedOptions[0].textContent}。`); });
      box.querySelector('.tts-local-save').addEventListener('click', () => apply({ local: { model: model.value, voice: voiceName.value } }, `本地语音服务：模型 ${model.value.trim() || 'tts-1'}，音色 ${voiceName.value.trim() || 'default'}。`));
    }
    box.querySelector('.tts-key-save').addEventListener('click', async () => {
      if (!key.value.trim()) return panelMsg('先在框里粘贴 API Key。');
      if (await apply({ key: { id, value: key.value } }, `${label.replace(/（.*）/, '')} 的 API Key 已保存。`)) key.value = '';
    });
    box.querySelector('.tts-key-del').addEventListener('click', () => apply({ key: { id, value: '' } }, `${label.replace(/（.*）/, '')} 的 API Key 已清除。`));
    box.querySelector('.tts-ep-save').addEventListener('click', () => apply({ endpoints: { [id]: ep.value } }, ep.value.trim() ? `端点已改为 ${ep.value.trim()}。` : local ? '本地语音服务的地址已清除。' : '端点已恢复默认。'));
    sec.querySelector('#tts-engines').appendChild(box);
  }
  sec.querySelector('#tts-clear').addEventListener('click', async () => {
    setSettings(await window.pet.ttsClearCache());
    paintVoiceStatus();
    panelMsg('语音缓存已清空。', true);
  });
  sec.querySelector('#tts-test').addEventListener('click', () => {
    if (!settings.prefs.voice) return panelMsg('先打开上面的“朗读回复”。');
    const sp = speciesOf(view.pet.speciesId);
    speak({ text: sp.catchphrase || `我是${sp.nameZh}。`, source: 'api', kind: 'api' });
    panelMsg('正在试听……', true);
  });
  setTimeout(paintVoiceStatus);
  return sec;
}
// Under 语音: AI voice notice, and her voice's credit on the engine she reads with (the chosen one, or
// under 按角色 her own default).
function paintVoiceCredit() {
  const el = $('tts-credit');
  if (!el) return;
  const sp = speciesOf(view.pet.speciesId);
  const t = (sp.voice && sp.voice.tts) || {};
  const mine = ['minimax', 'local'].includes(t.default) ? t.default : 'fish';
  const eng = ['fish', 'minimax', 'local'].includes(settings.tts.provider) ? settings.tts.provider : mine;
  const lo = settings.tts.local || {};
  const credit = eng === 'local' ? `你的本地语音服务${lo.api === 'whale' ? '（whale-voice）' : (t.local && t.local.voice) || lo.voice ? `（音色 ${(t.local && t.local.voice) || lo.voice}）` : ''}，用别人的声音前请先取得授权` : (t[eng] && t[eng].credit) || (t.fish && t.fish.credit);
  el.textContent = `语音由 AI 合成，不是真人录音。${settings.tts.provider === 'auto' ? `${sp.nameZh}默认用 ${TTS_NAME[mine]}。` : ''}${credit ? `${sp.nameZh}的音色：${credit}。` : ''}`;
}
// The status line under 语音: per engine whether a key is set and its last problem, and the cache.
// 语音包: whether her lines are recorded, by whom, and when they are used (core/voice-pack.js packApplies).
function paintVoicePacks() {
  const el = $('tts-packs-st');
  const st = settings && settings.ttsStatus;
  if (!el || !st || !view) return;
  const sp = speciesOf(view.pet.speciesId);
  const pack = (st.packs || []).find((p) => p.character === sp.id);
  if (!pack) { el.textContent = `${sp.nameZh}还没有语音包。`; return; }
  const engine = pack.engine === 'minimax' ? 'MiniMax' : pack.engine === 'fish' ? 'Fish Audio' : null;
  el.textContent = `${sp.nameZh}：${pack.builtIn ? '内置' : '你加的'}语音包「${pack.name}」，录好 ${pack.lines} 句。摸头、喂食、部位触摸、碎碎念这些固定台词直接播放，不联网、不用 Key、不占每分钟次数；她的回复仍由引擎合成。${engine ? `引擎选了别家并且能用时（比如 Fish Audio），为了声音一致不用这个 ${engine} 语音包；选“系统语音”时也不用。` : ''}`;
}
function paintVoiceStatus() {
  paintVoiceCredit();
  paintVoicePacks();
  const el = $('tts-status');
  const st = settings && settings.ttsStatus;
  if (!el || !st) return;
  const parts = TTS_ENGINES.filter((e) => e[3] && st.engines[e[0]]).map(([id, label]) => {
    const e = st.engines[id];
    const local = id === 'local';
    const box = document.querySelector(`.tts-engine[data-engine="${id}"] .tts-key`);
    if (box) box.placeholder = e.hasKey ? 'API Key：已设置（不显示）' : local ? 'API Key：可不填' : 'API Key：未设置';
    const budget = e.hasKey && e.rpm ? `，每分钟最多 ${e.rpm} 次，这一分钟还剩 ${e.budget}` : '';
    const has = local ? (e.ready ? `地址 ${settings.tts.endpoints.local}` : '没填地址') : e.hasKey ? 'Key 已设置' : '没有 Key';
    return `${label.replace(/（.*）/, '')}：${has}${budget}${e.lastError ? `，上次${ttsReason(e.lastError)}${e.pausedFor ? `，${ttsWait(e.pausedFor)}内跳过` : ''}` : ''}`;
  });
  el.textContent = `${parts.join('；')}。缓存 ${st.cache.count} 句，${(st.cache.bytes / 1024).toFixed(0)} KB。${st.encrypted ? 'Key 用系统钥匙串加密保存。' : 'Key 以只有你能读的文件保存在本机。'}`;
}

// First meeting: name her (like at hatch: optional, 12 characters, her own name by default), then she comes.
function askName(row, c, value = c.nameZh) {
  const open = document.querySelector('.char-name-form');
  if (open) open.remove();
  naming = { id: c.id, value };
  const form = document.createElement('form');
  form.className = 'size-row char-name-form';
  form.innerHTML = '<input maxlength="12" autocomplete="off" aria-label="名字" /><button class="btn primary" type="submit">请她来</button><button class="btn" type="button">取消</button>';
  const input = form.querySelector('input');
  input.value = value;
  input.placeholder = `给她起个名字（默认「${c.nameZh}」）`;
  input.addEventListener('input', () => { naming.value = input.value; });
  form.querySelector('button[type="button"]').addEventListener('click', () => { naming = null; form.remove(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    naming = null;
    for (const el of form.elements) el.disabled = true;
    switchCharacter(c, input.value);
  });
  row.after(form);
  // on a re-render the panel body is attached only after this row: focus once it is on screen
  setTimeout(() => {
    input.focus();
    if (value === c.nameZh) input.select();
  });
}

async function switchCharacter(c, name) {
  if (!c.met) {
    arriving = c.nameZh;
    panelMsg(`${c.nameZh}正在赶来…（在 LobeHub 里为她新建 agent）`, true);
  }
  let r;
  try {
    r = await window.pet.switchCharacter(c.id, name);
  } finally {
    arriving = null;
  }
  if (!r.ok) {
    // she did not come: the name form is usable again, for another try
    const form = document.querySelector('.char-name-form');
    if (form) for (const el of form.elements) el.disabled = false;
    if (r.reason === 'canceled') return panelMsg(`没有请${c.nameZh}来，还是原来的她陪你。`);
    panelMsg(r.reason === 'busy' ? '她正在忙，等她说完再换。' : r.reason === 'error' ? `${c.nameZh}没能来（${String(r.message || '').slice(0, 80)}），还是原来的她陪你。` : '现在没法切换。');
    return;
  }
  view = r.view;
  syncPrewarm();
  fx.clear();
  fx.setFacing('right');
  applyArt();
  refreshHud();
  renderPanel();
  fx.play('hatch', Fx.oneShotMs(isVideo(view.pet.speciesId), 'hatch'));
  panelMsg(r.created ? `「${view.pet.name}」来了！这是她自己的 agent，从陌生开始。` : `已切换为「${view.pet.name}」。`, true);
}

async function unlockAllNow(c) {
  if (!confirm(`把${c.nameZh}的好感度直接加满，解锁她的全部阶段、话题和服饰？这一步不能撤销。`)) return;
  const r = await window.pet.unlockAll(c.id);
  if (!r.ok) {
    panelMsg(r.reason === 'busy' ? '她正在忙，等她说完再试。' : r.reason === 'not-met' ? `还没认识${c.nameZh}。` : '现在没法解锁。');
    return;
  }
  view = r.view;
  applyArt();
  refreshHud();
  renderPanel();
  const n = (l) => (l ? l.length : 0);
  const outfits = n(r.unlocks.outfits);
  panelMsg(r.already ? `${c.nameZh}的好感度已加满，内容之前就已全部解锁。` : `已为${c.nameZh}解锁：${n(r.unlocks.topics)} 个话题${outfits ? `、${outfits} 套服饰。${c.current ? '去衣柜换上看看吧。' : '换成她之后去衣柜换上看看吧。'}` : '。'}`, true);
}

function renderWardrobe() {
  const list = view.outfits;
  const worn = list.find((o) => o.id === view.outfit) || list[0];
  $('panel-title').textContent = `衣柜 · ${view.pet.name}`;
  $('panel-sub').textContent = `${progressLine()} · 已解锁 ${list.filter((o) => o.unlocked).length}/${list.length} 套`;
  const body = $('panel-body');
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'wardrobe';
  const pv = document.createElement('div');
  pv.className = 'preview';
  pv.id = 'outfit-preview';
  pv.dataset.outfit = worn.id;
  const grownUp = !!(view.appearance && (view.appearance.options.find((x) => x.id === view.appearance.packId) || {}).adult);
  pv.innerHTML = `<div class="nm"></div><div class="adult-note">当前穿着 · ${grownUp ? '成年版（20 岁）' : '成年（18 岁）'}</div>`;
  pv.prepend(outfitArt(worn, view.pet.speciesId));
  pv.querySelector('.nm').textContent = worn.label;
  wrap.appendChild(pv);
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const o of list) {
    const card = document.createElement('button');
    card.className = `card${o.locked ? ' locked' : ''}${o.equipped ? ' equipped' : ''}`;
    card.dataset.outfit = o.id;
    const status = o.equipped ? '✓ 穿着中' : o.unlocked ? '点击穿上' : `🔒 ${o.condition}`;
    card.title = `${o.label}：${o.desc}`;
    card.setAttribute('aria-label', `${o.label}，${status}`);
    card.innerHTML = '<div class="nm"></div><div class="st"></div>';
    card.prepend(outfitArt(o, view.pet.speciesId));
    card.querySelector('.nm').textContent = o.label;
    card.querySelector('.st').textContent = status;
    if (o.rating === 'adult') card.insertAdjacentHTML('beforeend', '<span class="tag adult">成人向</span>');
    if (panelNew.has(o.id)) card.insertAdjacentHTML('beforeend', '<span class="tag new">新</span>');
    card.addEventListener('click', () => equip(o));
    grid.appendChild(card);
  }
  wrap.appendChild(grid);
  body.appendChild(wrap);
}

async function equip(o) {
  const r = await window.pet.equipOutfit(o.id);
  if (!r.ok) {
    panelMsg(r.reason === 'locked' ? `🔒 「${o.label}」还没解锁：${r.condition}` : '这件现在不能穿。');
    return;
  }
  view = r.view;
  applyArt();
  refreshHud();
  panelMsg(`换好了：「${r.outfit.label}」`, true);
}

function renderTopics() {
  const list = view.topics;
  $('panel-title').textContent = `话题 · ${view.pet.name}`;
  $('panel-sub').textContent = `${progressLine()} · 已解锁 ${list.filter((t) => t.unlocked).length}/${list.length} 个`;
  const body = $('panel-body');
  body.innerHTML = '';
  const groups = [];
  for (const t of list) {
    let g = groups.find((x) => x.stage === t.stage);
    if (!g) groups.push((g = { stage: t.stage, name: t.stageName, items: [] }));
    g.items.push(t);
  }
  for (const g of groups) {
    const sec = document.createElement('div');
    sec.className = 'topic-group';
    sec.innerHTML = '<h3></h3>';
    sec.querySelector('h3').textContent = `${g.name}${g.items[0].locked ? `（${g.items[0].condition}）` : ''}`;
    for (const t of g.items) {
      const b = document.createElement('button');
      b.className = `topic${t.locked ? ' locked' : ''}${t.talkedToday ? ' done' : ''}`;
      b.dataset.topic = t.id;
      const status = t.locked ? `🔒 ${t.condition}` : t.talkedToday ? '今天聊过了（不再加好感）' : '点击聊聊';
      b.setAttribute('aria-label', `${t.label}，${status}`);
      b.innerHTML = '<span class="nm"></span><span class="st"></span>';
      b.querySelector('.nm').textContent = t.label;
      b.querySelector('.st').textContent = status;
      if (t.rating === 'adult') b.querySelector('.nm').insertAdjacentHTML('beforeend', ' <span class="tag">成人向</span>');
      if (panelNew.has(t.id)) b.querySelector('.nm').insertAdjacentHTML('beforeend', ' <span class="tag">新</span>');
      b.addEventListener('click', () => startTopic(t));
      sec.appendChild(b);
    }
    body.appendChild(sec);
  }
}

async function startTopic(t) {
  if (t.locked) {
    const r = await window.pet.talkTopic(t.id); // refused by the main process as well
    panelMsg(`🔒 「${t.label}」还没解锁：${r.condition || t.condition}`);
    return;
  }
  closePanel();
  stopSpeech('new-message');
  const r = await window.pet.talkTopic(t.id);
  if (!r.ok && r.reason === 'busy') say('等等，我还在想上一句……', 'busy');
  if (!r.ok && r.reason === 'canceled') say('（好吧，不聊了。）', 'canceled', 'fallback');
}

function say(text, kind, source, reason, meme = null) {
  const b = $('bubble');
  if (bubbleEndsReading({ text, kind, source })) stopSpeech('bubble'); // the voice follows the bubble: another line there ends the reading
  clearTimeout(bubbleTimer);
  b.classList.remove('thinking');
  b.classList.remove('hidden');
  b.textContent = text;
  // a meme picture (core/memes.js): a sticker beside her while the line is shown
  b.dataset.meme = meme ? meme.id : '';
  const st = $('meme-sticker');
  st.classList.toggle('hidden', !meme);
  if (meme) {
    st.src = meme.url;
    st.alt = meme.label;
    st.title = meme.label;
  }
  b.scrollTop = 0;
  b.dataset.kind = kind || '';
  b.dataset.source = source || '';
  b.dataset.reason = reason || '';
  delete b.dataset.speech;
  talkUntil = performance.now() + Math.min(4000, 400 + text.length * 90);
  // work status: a failed turn shows the pet upset for a moment instead of talking
  if (kind === 'error' && fx) { talkUntil = 0; fx.play('sad', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'sad')); }
  const hideLater = (ms) => {
    bubbleTimer = setTimeout(() => (bubbleHold || (speaking() && b.dataset.speech === String(lastSpeech.n)) ? hideLater(3000) : (b.classList.add('hidden'), $('meme-sticker').classList.add('hidden'))), ms);
  };
  hideLater(Math.min(45000, 6000 + text.length * 150) + (meme ? 3000 : 0));
}

// Read a line aloud when 朗读 is on: the agent's replies and lines sent through the local API, and with
// 互动语音 her interaction lines too (core/interaction-voice.js; automatic murmurs only with 朗读碎碎念).
// The engine chosen under 高级设置 → 语音 synthesises it in main (core/tts.js) in her own voice; without a
// key, offline, on a timeout or an error the line goes to the system voice (core/voice.js, her own pitch
// and pace) or stays silent. A line is read whole, sentence by sentence in order (Voice.sentences): the
// next sentence is fetched while this one plays, and the bubble marks the one being read. One reading at
// a time: a new line, a new message from the owner, 朗读 switched off or another line in the bubble stops
// it at once — but an interaction line is dropped instead while another line is still being said, or
// within 1.5 s of the last (SpeechGate), so rapid clicks never pile up and never cut a reply short.
const SPEAKING = /^(queued|synthesizing|speaking|playing)$/;
let lastSpeech = null;
let speechSeq = 0;
let speechAudio = null;
let speechWake = null; // ends the sentence being read (a stopped reading never gets its `ended`)
const speechLog = []; // what was read when, for the e2e runs (window.petFx.speechLog)
const speechGate = new IVoice.SpeechGate({ now: () => performance.now() });
const offerLog = []; // every line offered to the voice (said or dropped by the gate), for the e2e runs
const speaking = () => !!(lastSpeech && SPEAKING.test(lastSpeech.status));
// The tier of the line still being synthesised or read (-1: none), for the gate.
const speakingTier = () => (speaking() ? lastSpeech.tier : -1);
// Whether a new line in the bubble ends the reading: not an interaction line the gate would drop anyway.
function bubbleEndsReading(m) {
  if (!speaking()) return false;
  const c = IVoice.classify(m);
  return !(c && c.tier === 0 && settings && IVoice.shouldSpeak(m, settings.prefs));
}
function speechEvent(rec, i, event, extra = {}) {
  speechLog.push({ n: rec.n, i, event, text: i == null ? null : rec.sentences[i].text, at: Math.round(performance.now()), ...extra });
  if (speechLog.length > 300) speechLog.shift();
}
function haltAudio() {
  if (speechAudio) { speechAudio.pause(); URL.revokeObjectURL(speechAudio.src); speechAudio = null; }
  if (window.speechSynthesis) speechSynthesis.cancel();
}
function stopSpeech(why = 'interrupted') {
  speechSeq++;
  const rec = lastSpeech;
  if (rec && SPEAKING.test(rec.status)) {
    rec.status = 'interrupted';
    rec.stoppedBy = why;
    const s = rec.sentences[rec.current];
    if (s && SPEAKING.test(s.status)) s.status = 'interrupted';
    speechEvent(rec, rec.current, 'stop', { why });
  }
  haltAudio();
  window.pet.ttsCancel();
  if (speechWake) { const w = speechWake; speechWake = null; w(); }
  markReading(null);
}
// A line that arrives before her screen is up (初次见面, said while hatching) waits for enterPet().
let pendingSpeech = null;
async function speak(m) {
  if (!settings || !settings.prefs || !IVoice.shouldSpeak(m, settings.prefs)) return;
  if (!view) { pendingSpeech = { m, at: performance.now() }; return; }
  const c = IVoice.classify(m);
  // replies and milestones are read sentence by sentence; an interaction line or a murmur is short and
  // read whole, as it was synthesised ahead (prewarm caches whole lines)
  const parts = c.tier === 0 ? [{ raw: m.text, say: Voice.speakable(m.text) }] : Voice.sentences(m.text);
  const said = parts.filter((p) => p.say);
  if (!said.length) return;
  const g = speechGate.admit(c, speakingTier());
  const offer = { at: Math.round(performance.now()), kind: m.kind, cls: c.cls, interaction: c.interaction, text: said.map((p) => p.say).join(' '), said: g.ok, dropped: g.ok ? null : g.reason, n: null };
  offerLog.push(offer);
  if (offerLog.length > 200) offerLog.shift();
  if (!g.ok) return;
  stopSpeech('new-line');
  const seq = speechSeq;
  offer.n = seq;
  const tts = settings.tts || { provider: 'system', fallback: 'system' };
  const mood = IVoice.moodFor(m);
  const rec = {
    n: seq, at: performance.now(), text: offer.text, sentences: said.map((p, i) => ({ i, text: p.say, status: 'queued', provider: null })), current: 0,
    kind: m.kind, interaction: c.interaction, tier: c.tier, mood: mood === null ? view.status : mood,
    species: m.speciesId || view.pet.speciesId, engine: tts.provider, provider: null, cached: false, latencyMs: 0, fellBackFrom: [], status: 'queued',
  };
  lastSpeech = rec;
  speechEvent(rec, null, 'begin', { sentences: said.length });
  showSentences(rec, m.text, parts);
  let next = synthesize(rec, 0, tts);
  for (let i = 0; i < said.length; i++) {
    if (tts.provider !== 'system' && !/^(playing|speaking)$/.test(rec.status)) rec.status = 'synthesizing';
    const r = await next;
    if (seq !== speechSeq) return;
    if (r.reason === 'interrupted') { rec.status = 'interrupted'; markReading(null); return; } // another window took the engine
    next = i + 1 < said.length ? synthesize(rec, i + 1, tts) : null; // the next sentence is fetched while this one is read
    await readSentence(rec, i, r);
    if (seq !== speechSeq) return;
  }
  rec.status = rec.sentences.every((s) => s.status === 'silent') ? 'silent' : 'done';
  speechEvent(rec, null, 'end', { status: rec.status });
  markReading(null);
}
// The audio for sentence i (or what to do instead: the system voice, silence).
async function synthesize(rec, i, tts) {
  const s = rec.sentences[i];
  if (tts.provider === 'system') return { ok: false, next: 'system', fellBackFrom: [] };
  s.status = 'synthesizing';
  const r = navigator.onLine === false
    ? { ok: false, fallback: tts.fallback, fellBackFrom: [{ provider: tts.provider, reason: 'offline' }] }
    : await window.pet.ttsSynthesize(s.text, rec.mood).catch((e) => ({ ok: false, fallback: tts.fallback, fellBackFrom: [{ provider: tts.provider, reason: `ipc: ${e.message}` }] }));
  if (!r.ok && r.reason !== 'interrupted' && r.next !== 'system' && r.fallback === 'silent') r.silent = true;
  Object.assign(s, { fellBackFrom: r.fellBackFrom || [], latencyMs: r.latencyMs || 0, status: 'queued' });
  return r;
}
// Read one sentence; resolves when it has been read, failed, or the reading was stopped.
function readSentence(rec, i, r) {
  const s = rec.sentences[i];
  rec.current = i;
  Object.assign(rec, { fellBackFrom: r.fellBackFrom || [], latencyMs: r.latencyMs || 0 });
  return new Promise((resolve) => {
    let guard = null;
    const end = (status) => {
      if (speechWake !== resolve) return;
      speechWake = null;
      clearTimeout(guard);
      s.status = status;
      speechEvent(rec, i, 'done', { status });
      resolve();
    };
    speechWake = resolve;
    speechEvent(rec, i, 'start', { provider: r.ok ? r.provider : r.silent ? null : 'system', cached: !!r.cached });
    markReading(rec, i);
    if (r.silent) { Object.assign(rec, { provider: null, status: 'silent' }); s.provider = null; return end('silent'); }
    // a voice that never reports its end (no system voice on this box, a stuck player) does not hold the rest up
    guard = setTimeout(() => end('timeout'), 4000 + [...s.text].length * 600);
    if (r.ok) playAudio(rec, s, r, end);
    else speakSystem(rec, s, end);
  });
}
// 拖拽 / 甩出 / 接住 have no line from main: she says one of hers (voice.lines in her file), in the
// bubble and aloud, only with 朗读 and 互动语音 on, and at most once every few seconds per kind.
const LOCAL_LINE_GAP_MS = 4000;
const localLineAt = {};
function localLine(kind) {
  const p = settings && settings.prefs;
  if (VISITOR || !p || !p.voice || p.voiceInteractions === false || !view || thinking) return;
  const now = performance.now();
  if (now - (localLineAt[kind] || -Infinity) < LOCAL_LINE_GAP_MS) return;
  localLineAt[kind] = now;
  const pool = IVoice.localLines(speciesOf(view.pet.speciesId), kind);
  if (!pool.length) return;
  const text = pool[Math.floor(Math.random() * pool.length)];
  say(text, kind, 'fallback');
  speak({ text, source: 'fallback', kind });
}
// Her common short lines are synthesised ahead (main.js tts-prewarm) whenever what they depend on
// changes: 朗读 / 互动语音 switched on, the engine or its key, her character or relationship stage.
let prewarmSig = null;
let prewarmTimer = null;
let lastPrewarm = null;
function syncPrewarm() {
  const p = settings && settings.prefs;
  if (!p || !p.voice || p.voiceInteractions === false || !view || !view.pet || VISITOR) { prewarmSig = null; return; }
  const t = settings.tts || {};
  const keys = settings.ttsStatus ? Object.entries(settings.ttsStatus.engines).map(([id, e]) => `${id}:${e.hasKey}:${e.ready}`).join(',') : '';
  const sig = [t.provider, t.fallback, JSON.stringify(t.endpoints || {}), JSON.stringify(t.local || {}), keys, view.pet.speciesId, view.pet.relStage, p.touchZones, settings.adultContent].join('|');
  if (sig === prewarmSig) return;
  prewarmSig = sig;
  clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(async () => {
    const t0 = performance.now();
    lastPrewarm = { sig, status: 'running' };
    const r = await window.pet.ttsPrewarm().catch((e) => ({ failed: `ipc: ${e.message}` }));
    if (lastPrewarm && lastPrewarm.sig === sig) lastPrewarm = { sig, status: 'done', ms: Math.round(performance.now() - t0), ...r };
  }, 400);
}
function playAudio(rec, s, r, end) {
  Object.assign(s, { provider: r.provider, cached: r.cached, status: 'playing' });
  Object.assign(rec, { provider: r.provider, voiceId: r.voiceId, model: r.model, cached: r.cached, mime: r.mime, bytes: r.audio.byteLength, status: 'playing' });
  const a = new Audio(URL.createObjectURL(new Blob([r.audio], { type: r.mime })));
  speechAudio = a;
  if (window.PetVRM && window.PetVRM.active()) window.PetVRM.lip.attach(a); // a VRM figure's mouth follows the voice
  a.onplaying = () => { rec.started = s.started = true; talkFor(Number.isFinite(a.duration) ? a.duration * 1000 : 0, s.text); };
  a.onended = () => { if (speechAudio === a) haltAudio(); end('done'); };
  a.onerror = () => end(`error: ${a.error ? a.error.code : '?'}`);
  a.play().catch((e) => end(`error: ${e.name}`));
}
// The last provider of the chain: Web Speech (core/voice.js webSpeech) with her own pitch and pace.
function speakSystem(rec, s, end) {
  rec.provider = s.provider = 'system';
  const env = { speechSynthesis: window.speechSynthesis, SpeechSynthesisUtterance: window.SpeechSynthesisUtterance };
  if (!Voice.webSpeech.available(env)) { rec.status = 'silent'; return end('silent'); }
  const v = Voice.webSpeech.config(speciesOf(rec.species).voice);
  Object.assign(rec, { lang: v.lang, pitch: v.pitch, rate: v.rate, status: 'queued' });
  Object.assign(rec, Voice.webSpeech.speak(s.text, v, env, {
    start: () => { rec.status = s.status = 'speaking'; talkFor(0, s.text); },
    end: () => end('done'),
    error: (e) => end(`error: ${e}`),
  }));
}
// Her mouth moves while a sentence is read.
function talkFor(ms, text) { talkUntil = Math.max(talkUntil, performance.now() + Math.min(30000, ms || [...text].length * 220)); }
// The bubble as sentences while it is read: the reply is still shown whole, the sentence being read is
// marked and scrolled into view. Only when the bubble still shows this reply (say() put it there).
function showSentences(rec, text, parts) {
  const b = $('bubble');
  if (b.classList.contains('hidden') || b.textContent !== text) return;
  b.textContent = '';
  let i = 0;
  for (const p of parts) {
    if (!p.say) { b.appendChild(document.createTextNode(p.raw)); continue; }
    const el = document.createElement('span');
    el.className = 'sentence';
    el.dataset.i = i++;
    el.textContent = p.raw;
    b.appendChild(el);
  }
  b.dataset.speech = rec.n;
}
function markReading(rec, i) {
  const b = $('bubble');
  for (const el of b.querySelectorAll('.sentence.reading')) el.classList.remove('reading');
  if (!rec || b.dataset.speech !== String(rec.n)) return;
  const el = b.querySelector(`.sentence[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('reading');
  const br = b.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (er.top < br.top || er.bottom > br.bottom) b.scrollTop += er.top - br.top - 4;
}

function setThinking(on) {
  thinking = on;
  document.body.classList.toggle('busy', on);
  clearInterval(thinkTimer);
  const b = $('bubble');
  if (on) {
    // nothing but the pet and this bubble while it works; controls come back when it is done
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    $('food-menu').classList.add('hidden');
    $('main-menu').classList.add('hidden');
    clearTimeout(bubbleTimer);
    $('meme-sticker').classList.add('hidden');
    b.classList.remove('hidden');
    b.classList.add('thinking');
    let n = 0;
    const tick = () => { b.textContent = `${arriving ? `${arriving}正在赶来` : '思考中'}${'.'.repeat((n++ % 3) + 1)}`; };
    tick();
    thinkTimer = setInterval(tick, 450);
  }
  syncHover();
}

// Tell the owner what actually went wrong instead of blaming "the network" for everything.
function errorLine(r) {
  if (r.code === 'ETIMEDOUT') return '（我想了好久也没想出来……LobeHub 现在好像很慢，晚点再说一次？）';
  if (r.code === 'EAUTH') return '（LobeHub 登录好像过期了，需要重新 lh login）';
  if (r.code === 'ECLI') return '（lh 版本和应用对不上，试试 lh update，或升级桌宠）';
  if (r.code === 'ENOENT') return '（找不到 lh 命令，请先 npm install -g @lobehub/cli）';
  if (r.code === 'ENOREPLY') return '（我走神了，没想出要说什么……再说一次？）';
  return `（出错了：${String(r.message || '未知错误').slice(0, 70)}）`;
}

async function doAct(kind, food) {
  if (thinking) return;
  const r = await window.pet.act(kind, food);
  const video = isVideo(view && view.pet.speciesId);
  if (kind === 'feed' && r.ok) {
    eating = FOOD_SPRITE[food] || 'rice';
    setTimeout(() => { eating = null; }, Fx.oneShotMs(video, 'eat'));
  }
  if (r.ok) {
    if (kind === 'pat') fx.click(video);
    if (kind === 'play') fx.play('play', Fx.oneShotMs(video, 'play'));
  }
}

function buildFoodMenu() {
  const m = $('food-menu');
  m.innerHTML = '';
  for (const [id, f] of Object.entries(info.foods)) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = f.label;
    b.addEventListener('click', () => { m.classList.add('hidden'); doAct('feed', id); });
    m.appendChild(b);
  }
}

function bindPetUi() {
  buildFoodMenu();
  $('toolbar').addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    $('food-menu').classList.add('hidden');
    $('main-menu').classList.add('hidden');
    $('action-menu').classList.add('hidden');
    if (act === 'feed') $('food-menu').classList.toggle('hidden');
    else if (act === 'play' || act === 'sleep') doAct(act);
    else if (act === 'wardrobe' || act === 'topics') openPanel(act);
    else if (act === 'chat') {
      $('chat-row').classList.toggle('hidden');
      if (!$('chat-row').classList.contains('hidden')) $('chat-input').focus();
    } else if (act === 'menu') $('main-menu').classList.toggle('hidden');
  });
  // 动作: play any effect on request (dsh-pet's right-click "动作" menu)
  $('action-menu').addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.cue;
    if (!a) return;
    $('action-menu').classList.add('hidden');
    if (thinking) return;
    fx.cue(a, isVideo(view && view.pet.speciesId));
  });
  $('main-menu').addEventListener('click', async (e) => {
    const m = e.target.dataset && e.target.dataset.menu;
    if (!m) return;
    $('main-menu').classList.add('hidden');
    if (m === 'actions') { $('action-menu').classList.remove('hidden'); return; }
    if (m === 'home') { fx.stopThrow(); fx.stopWalk(); window.pet.place('pet'); return; } // dsh-pet 回到原位
    if (m === 'quit') window.pet.quit();
    if (m === 'advanced') openPanel('advanced');
    if (m === 'characters') openPanel('characters');
    if (m === 'history') { window.PetHistory.reset(); openPanel('history'); }
    if (m === 'new-topic') {
      if (!confirm('和她开一个新话题？\n她会从头聊起，不再带着之前的对话上下文。旧话题不会删除，仍保留在 LobeHub 里；好感度和聊天记录也都保留。')) return;
      const r = await window.pet.newTopic();
      if (r.ok) {
        view = r.view;
        say('（好，我们换个新话题，从头聊起吧。）', 'settings', 'fallback');
      } else say(r.reason === 'busy' ? '等等，我还在想上一句……' : '（现在没法重新开始。）', r.reason === 'busy' ? 'busy' : 'error', 'fallback');
    }
    if (m === 'check-update') {
      await openPanel('advanced');
      $('update-section').scrollIntoView({ block: 'nearest' });
      window.pet.checkUpdate();
    }
    if (m === 'update') await window.pet.installUpdate();
    if (m === 'adult') {
      const label = (v, id) => ((v.outfits.find((o) => o.id === id) || {}).label || id);
      if (!view.settings.ageConfirmed) {
        // Only the same 18+ confirmation can turn adult content on; there is no other way in.
        showAgeGate((r) => {
          enterPet(r.view);
          say(r.settings.adultContent ? '（成人向内容已开启，可以随时在菜单里关闭。）' : '（好的，继续只看全年龄内容。）', 'settings', 'fallback');
        });
        return;
      }
      const r = await window.pet.setAdult(!view.settings.adultContent);
      if (r.ok) {
        view = r.view;
        refreshHud();
        say(r.settings.adultContent ? '（成人向内容已开启。）' : `（成人向内容已关闭${r.outfitChanged ? `，已换回「${label(r.view, r.outfitChanged.to)}」` : ''}。）`, 'settings', 'fallback');
      }
    }
    if (m === 'log') window.pet.openLog();
    if (m === 'local') {
      const on = !(view && view.local && view.local.enabled);
      if (on && !confirm('让宠物使用这台电脑？\n它可以读写文件、搜索内容、运行命令，能碰到你账号权限内的所有东西（不是沙盒）。')) return;
      const r = await window.pet.setLocal(on);
      if (r.ok) say(on ? '（已连上这台电脑，要我帮你找什么？）' : '（好，我不碰你的电脑了。）', 'local', 'fallback');
      else if (r.reason === 'canceled') say('（好，先不弄了。）', 'canceled', 'fallback');
      else if (r.reason !== 'busy') say(`（没成功：${String(r.message || '未知原因').slice(0, 60)}）`, 'error', 'fallback', r.message);
    }
    if (m === 'credits') alert(credits());
    if (m === 'release' && confirm('放生它，并在 LobeHub 里删除每位角色的 agent（含聊天记录）？')) await release(true);
    if (m === 'forget' && confirm('只重置本地进度，LobeHub 里的 agent 会保留。继续？')) await release(false);
  });
  const send = async () => {
    const input = $('chat-input');
    const text = input.value.trim();
    if ((!text && attachments.length === 0) || thinking) return;
    const imgs = attachments.filter((a) => a.kind === 'image');
    const files = attachments.filter((a) => a.kind === 'path').map((a) => a.path);
    if (files.length && !(view && view.local && view.local.enabled)) {
      if (!confirm('读本机文件需要先开启“本机能力”（让宠物使用这台电脑）。现在开启吗？')) return;
      const on = await window.pet.setLocal(true);
      if (!on.ok) { say(`（没能开启本机能力：${String(on.message || '未知原因').slice(0, 60)}）`, 'error', 'fallback', on.message); return; }
    }
    stopSpeech('new-message'); // she stops reading the last reply as soon as the owner says something
    attachments = [];
    renderAttachments();
    input.value = '';
    $('chat-send').disabled = true;
    const r = await window.pet.chat(text, imgs, files);
    $('chat-send').disabled = false;
    if (!r.ok && r.reason === 'error') say(errorLine(r), 'error', 'error', r.message);
    if (!r.ok && r.reason === 'local-error') say(`（这台电脑现在连不上，读不了文件：${String(r.message || '').slice(0, 60)}）`, 'error', 'fallback', r.message);
    if (!r.ok && r.reason === 'local-off') say('（要先开启本机能力才能读文件。）', 'error', 'fallback');
    if (!r.ok && r.reason === 'canceled') say('（好吧，不想了。）', 'canceled', 'fallback');
    if (!r.ok && r.reason === 'busy') say('等等，我还在想上一句……', 'busy');
  };
  $('chat-send').addEventListener('click', send);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  // ---- pictures: paste (Ctrl/⌘+V), drag in, or the 📎 button; Escape stops a running task
  document.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length || $('pet-screen').classList.contains('hidden') || !pointerInside) return; // hover the pet first
    e.preventDefault();
    if (thinking) return;
    openChat();
    routeFiles(files);
  });
  document.addEventListener('dragover', (e) => { if ([...(e.dataTransfer ? e.dataTransfer.types : [])].includes('Files')) { e.preventDefault(); document.body.classList.add('dragging-file'); } });
  document.addEventListener('dragleave', () => document.body.classList.remove('dragging-file'));
  document.addEventListener('drop', (e) => {
    document.body.classList.remove('dragging-file');
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length || thinking || $('pet-screen').classList.contains('hidden')) return;
    e.preventDefault();
    openChat();
    routeFiles(files);
  });
  $('attach-btn').addEventListener('click', async () => {
    const picked = await window.pet.pickImages();
    for (const img of picked) pushAttachment({ kind: 'image', ...img });
  });
  bindMic();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && thinking) window.pet.cancel(); });
  $('stop-btn').addEventListener('click', () => { if (thinking) window.pet.cancel(); });
  $('bubble').addEventListener('mouseenter', () => { bubbleHold = true; });
  $('bubble').addEventListener('mouseleave', () => { bubbleHold = false; });

  bindPetPointer({ onClick: touchAt, onMenu: openMenuAtPet });
  bindTouchHint();
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest || !e.target.closest('.pet-hit')) return;
    e.preventDefault();
    openMenuAtPet();
  });
}

// The menu from a right click, or a long press on a touch screen.
function openMenuAtPet() {
  if (thinking) return;
  pointerInside = true;
  syncHover();
  $('food-menu').classList.add('hidden');
  $('action-menu').classList.add('hidden');
  $('main-menu').classList.remove('hidden');
}

// Mouse, pen and touch on the pet (pointer events; dsh-pet drag.ts, drag-release.ts, touch-press.ts):
// - a press without moving is a click (`onClick`, given the pointerup event: where it landed);
// - drag it and it is lifted; let go while moving fast and it is thrown (gravity, bounces off the
//   screen edges); let go slowly and it is just put down;
// - press twice quickly, pull and let go: the slingshot launches it the opposite way of the pull;
// - press it while it flies: caught, with a score for a fast one;
// - touch: a long press held still opens the menu (`onMenu`), like a right click.
function bindPetPointer({ onClick, onMenu }) {
  let drag = null;
  let lastPressAt = null;
  const end = (e, cancel) => {
    const d = drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    drag = null;
    clearTimeout(d.press);
    fx.setLifted(false);
    if (cancel || d.menu) return;
    if (!d.moved) return d.caught ? null : onClick(e);
    if (d.sling) {
      const box = petHitBox();
      const v = Fx.slingshotVelocity(d.x - d.x0, d.y - d.y0, box ? box.w : 150);
      if (Fx.isThrow(v)) { throwPet(v); localLine('throw'); }
      return;
    }
    const v = Fx.releaseVelocity(d.samples, performance.now());
    if (Fx.isThrow(v)) { throwPet(v); localLine('throw'); }
  };
  for (const el of document.querySelectorAll('.pet-hit')) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const now = performance.now();
      const caught = fx.flying ? fx.catchScore() : 0;
      fx.stopThrow();
      fx.stopWalk();
      const sling = !caught && Fx.isSlingshot(lastPressAt, now);
      lastPressAt = now;
      drag = { id: e.pointerId, type: e.pointerType, x0: e.screenX, y0: e.screenY, x: e.screenX, y: e.screenY, moved: false, caught, sling, travel: 0, samples: [{ x: e.screenX, y: e.screenY, t: now }] };
      if (caught) { fx.play('happy', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'happy')); localLine('catch'); }
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
      if (e.pointerType === 'touch') {
        const d = drag;
        d.press = setTimeout(() => {
          if (drag === d && Fx.isLongPress(performance.now() - now, d.travel)) { d.menu = true; drag = null; onMenu(); }
        }, Fx.LONG_PRESS.ms);
      }
    });
  }
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    drag.travel += Math.abs(dx) + Math.abs(dy);
    if (!drag.moved && drag.travel > (drag.type === 'touch' ? Fx.LONG_PRESS.slop : 3)) { drag.moved = true; localLine('lift'); }
    if (drag.moved) {
      clearTimeout(drag.press);
      fx.setLifted(true);
      window.pet.moveBy(dx, dy);
      drag.x = e.screenX;
      drag.y = e.screenY;
      drag.samples.push({ x: e.screenX, y: e.screenY, t: performance.now() });
      if (drag.samples.length > 12) drag.samples.shift();
    }
  });
  window.addEventListener('pointerup', (e) => end(e, false));
  window.addEventListener('pointercancel', (e) => end(e, true));
}

// Behaviour switches for the effects layer; she never walks off while a panel has the window enlarged.
function petPrefs() {
  const p = (settings && settings.prefs) || {};
  return panelKind ? { ...p, roam: false } : p;
}

// Where the character is drawn in the window (for knocking into other pets): its art, not the whole window.
function petHitBox() {
  const el = isVideo(view && view.pet.speciesId) ? $('vwrap') : $('char-wrap');
  const r = el && el.getBoundingClientRect();
  if (!r || !r.width) return null;
  return { x: Math.round(r.left + r.width * 0.15), y: Math.round(r.top + r.height * 0.1), w: Math.round(r.width * 0.7), h: Math.round(r.height * 0.9) };
}

// ---------- touching a body part (部位触摸, src/core/touch-zones.js) ----------
// A click is mapped onto her art as the core's hit test wants it: x, y in 0..1 of the visible box (the
// bounding box of the opaque pixels of what is drawn right now), plus whether the pixel under the
// pointer is opaque (sheets come over pack:// with CORS, so the page may read them). Works for the
// sprite canvas or picture (object-fit: contain in .char) and for Dafeiyu's clip (cropped by .vwrap),
// mirrored when she faces left, at any pet size.
const TZ = window.PetTouchZones;
const touchOn = () => !settings || !settings.prefs || settings.prefs.touchZones !== false;
const ALPHA_MIN = 24; // a pixel this opaque counts as her
const SAMPLE_W = 320; // a clip frame is read scaled down to this width
const NEAR_PX = 6; // a click this close to her (screen px) still counts: thin parts (a tail) move

// The element her art is drawn in and its source size, or null while nothing is drawn yet.
function artSource() {
  if (isVideo(view && view.pet.speciesId)) {
    const v = $('pet-video');
    return v.videoWidth ? { el: v, w: v.videoWidth, h: v.videoHeight, video: true } : null;
  }
  const el = $('pet-look').firstElementChild;
  if (el && el.tagName === 'CANVAS') return { el, w: el.width, h: el.height, video: false };
  if (el && el.tagName === 'IMG' && el.naturalWidth) return { el, w: el.naturalWidth, h: el.naturalHeight, video: false };
  return null;
}

// The alpha of the drawn frame and its opaque bounding box (source px); null if it cannot be read.
// Kept for the frame on screen, so hovering and clicking read the pixels once per frame.
let alphaCache = { key: null, map: null };
function alphaMap(a) {
  const key = a.video ? `${a.el.currentSrc}@${a.el.currentTime}` : a.el.tagName === 'CANVAS' ? a.el.dataset.frame : a.el.src;
  if (key && alphaCache.key === key) return alphaCache.map;
  const map = readAlpha(a);
  alphaCache = { key, map };
  return map;
}
function readAlpha(a) {
  const k = Math.min(1, SAMPLE_W / a.w);
  const w = Math.max(1, Math.round(a.w * k));
  const h = Math.max(1, Math.round(a.h * k));
  let data;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(a.el, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // a tainted picture: treat the whole frame as her
  }
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < ALPHA_MIN) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const opaqueAt = (px, py, rSrc) => {
    const cx = Math.floor(px * k);
    const cy = Math.floor(py * k);
    const r = Math.max(1, Math.ceil(rSrc * k));
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= ALPHA_MIN) return true;
    return false;
  };
  return { box: { x0: x0 / k, y0: y0 / k, x1: (x1 + 1) / k, y1: (y1 + 1) / k }, opaqueAt };
}

// Where client point (cx, cy) lands on her art: { x, y, opaque, pose, box } with `box` the visible
// box on screen (client px, for placing the reaction), or null when she is not drawn.
function artPoint(cx, cy) {
  const a = artSource();
  if (!a) return null;
  const r = a.el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const fit = Math.min(r.width / a.w, r.height / a.h); // object-fit: contain, centred
  const ox = r.left + (r.width - a.w * fit) / 2;
  const oy = r.top + (r.height - a.h * fit) / 2;
  const mirrored = $('pet-body').dataset.facing === 'left';
  const px = mirrored ? a.w - (cx - ox) / fit : (cx - ox) / fit;
  const py = (cy - oy) / fit;
  const m = alphaMap(a);
  // a clip from file:// cannot be read back: her box in the frame comes from her file (touch.videoBox)
  const vb = !m && a.video && (speciesOf(view.pet.speciesId).touch || {}).videoBox;
  const b = m ? m.box : vb ? { x0: vb[0] * a.w, y0: vb[1] * a.h, x1: vb[2] * a.w, y1: vb[3] * a.h } : { x0: 0, y0: 0, x1: a.w, y1: a.h };
  const sx = (v) => (mirrored ? ox + (a.w - v) * fit : ox + v * fit);
  const box = { left: Math.min(sx(b.x0), sx(b.x1)), right: Math.max(sx(b.x0), sx(b.x1)), top: oy + b.y0 * fit, bottom: oy + b.y1 * fit };
  const pose = a.video ? 'video' : $('pet-body').dataset.action || null;
  return { x: (px - b.x0) / (b.x1 - b.x0), y: (py - b.y0) / (b.y1 - b.y0), opaque: m ? m.opaqueAt(px, py, NEAR_PX / fit) : true, pose, box, mirrored };
}

// The body part under client point (cx, cy), or null (off her art, a transparent pixel, no part there).
function zoneAtClient(cx, cy) {
  const pt = artPoint(cx, cy);
  if (!pt) return { zone: null, pt: null };
  return { zone: TZ.zoneAt(pt.x, pt.y, { character: speciesOf(view.pet.speciesId), pose: pt.pose, opaque: pt.opaque }), pt };
}

// A click on her: touch the part it landed on. With 部位触摸 off, or between parts (a transparent
// pixel, a spot no zone covers), it is the old single pat.
async function touchAt(e) {
  if (thinking || !view) return;
  if (!touchOn() || !e || !Number.isFinite(e.clientX)) return doAct('pat');
  const { zone, pt } = zoneAtClient(e.clientX, e.clientY);
  if (!zone) return doAct('pat');
  const r = await window.pet.touch(zone);
  if (r.ok) showTouch(r, pt, { x: e.clientX, y: e.clientY });
  return r;
}

// Her reaction: the zone's own clip (touch-<zone>) if her art has one, else the pat clip; and that
// part's marks over her (fx.js touchFx: a hand patting her head, a blush, an anger mark, …).
function showTouch(r, pt, at) {
  const video = isVideo(view.pet.speciesId);
  const sp = speciesOf(view.pet.speciesId);
  const has = (n) => (video ? !!sp.clips[n] : !!(view.look && ((view.look.kind === 'sprites' && view.look.actions[n]) || (isLive(view.look) && n.startsWith('touch-')))));
  const clip = has(r.reaction.anim) ? r.reaction.anim : 'pat';
  // client px → px inside #pet-body (the stage is zoomed by the pet size)
  const pb = $('pet-body');
  const pr = pb.getBoundingClientRect();
  const k = pr.width / (pb.offsetWidth || pr.width) || 1;
  const lx = (x) => (x - pr.left) / k;
  const ly = (y) => (y - pr.top) / k;
  const box = { left: lx(pt.box.left), top: ly(pt.box.top), width: (pt.box.right - pt.box.left) / k, height: (pt.box.bottom - pt.box.top) / k, mirrored: pt.mirrored };
  // her face in the box (0..1), for the blush: from her zone table (a chibi's face sits much lower)
  const fz = TZ.zonesFor(sp, pt.pose).find((z) => z.id === 'face');
  if (fz) box.face = fz.rects[0];
  lastTouch = { n: (lastTouch ? lastTouch.n : 0) + 1, zone: r.zone, mood: r.reaction.mood, clip, line: r.line };
  fx.touch({ zone: r.zone, mood: r.reaction.mood, clip, ms: video ? 3000 : 1600, box, at: { x: lx(at.x), y: ly(at.y) } });
}
let lastTouch = null;

// Hovering over her with 触摸提示 on: the part under the pointer, named beside it.
function bindTouchHint() {
  const hint = $('zone-hint');
  let pending = null; // the latest pointermove, looked at once per frame
  const clear = () => {
    pending = null;
    hint.classList.add('hidden');
    if ($('pet-body').dataset.hoverZone) $('pet-body').dataset.hoverZone = '';
  };
  const look = () => {
    const e = pending;
    pending = null;
    if (!e) return;
    if (!view || thinking || e.buttons || fx.lifted || fx.flying || !touchOn() || !(settings && settings.prefs && settings.prefs.touchHint)) return clear();
    const { zone } = zoneAtClient(e.clientX, e.clientY);
    if (!zone) return clear();
    $('pet-body').dataset.hoverZone = zone;
    hint.textContent = `👆 ${TZ.ZONES[zone].label}`;
    hint.style.left = `${e.clientX + 12}px`;
    hint.style.top = `${e.clientY + 10}px`;
    hint.classList.remove('hidden');
  };
  for (const el of document.querySelectorAll('.pet-hit')) {
    el.addEventListener('pointermove', (e) => {
      if (!pending) requestAnimationFrame(look);
      pending = { clientX: e.clientX, clientY: e.clientY, buttons: e.buttons };
    });
    el.addEventListener('pointerleave', clear);
    el.addEventListener('pointerdown', clear);
  }
}

// Thrown: in the air it is `lifted`; landing squashes it, then it shakes it off.
function throwPet(v) {
  return fx.throwPet(v, { onLand: () => fx.play('pat', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'pat')) });
}

// Controls are hidden unless the pointer is over the window (or one is in use).
// The controls exist only while the pointer is over the pet window (and it is not working). Nothing
// keeps them open: moving away hides everything, even an open chat box. The draft text and attached
// files are kept and come back with the next hover.
function syncHover() {
  document.body.classList.toggle('over', pointerInside); // pointer over the window (used by the stop button)
  document.body.classList.toggle('hover', !thinking && (pointerInside || micActive())); // listening keeps 🎤 in reach
  if (!pointerInside && !micActive()) {
    if (document.activeElement === $('chat-input')) $('chat-input').blur(); // keystrokes must not go into a hidden box
    $('food-menu').classList.add('hidden');
    $('main-menu').classList.add('hidden');
  }
}
function bindHover() {
  const root = document.documentElement;
  const set = (inside) => { if (pointerInside !== inside) { pointerInside = inside; syncHover(); } };
  root.addEventListener('mouseenter', () => set(true));
  root.addEventListener('mouseleave', () => set(false));
  window.addEventListener('mousemove', () => set(true));
  window.addEventListener('blur', () => set(false));
  // dragging a file over the window counts as being on the pet (no mouse events fire during an OS drag)
  document.addEventListener('dragenter', () => set(true));
  document.addEventListener('dragover', () => set(true));
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) set(false); });
}

// ---------- pictures and files to send ----------
const MAX_ATTACH = 10;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function openChat() {
  $('chat-row').classList.remove('hidden');
  syncHover();
  $('chat-input').focus();
}

function pushAttachment(a) {
  if (attachments.length >= MAX_ATTACH) { say(`（一次最多 ${MAX_ATTACH} 个。）`, 'limit', 'fallback'); return; }
  if (a.kind === 'path' && attachments.some((x) => x.path === a.path)) return;
  if (a.kind === 'image' && attachments.filter((x) => x.kind === 'image').length >= MAX_IMAGES) { say(`（图片一次最多 ${MAX_IMAGES} 张。）`, 'limit', 'fallback'); return; }
  attachments.push(a);
  renderAttachments();
}

function addImageFile(file) {
  if (file.size > MAX_IMAGE_BYTES) { say('（这张图太大了，换一张小于 8MB 的吧。）', 'limit', 'fallback'); return; }
  const reader = new FileReader();
  reader.onload = () => pushAttachment({ kind: 'image', dataUrl: reader.result, name: file.name || 'pasted.png' });
  reader.readAsDataURL(file);
}

// A dropped or pasted File that lives on disk is handed over by PATH (nothing is uploaded; the agent
// reads it through the bound device). Data without a path (a screenshot on the clipboard) is an
// image to upload so the model can see it.
function routeFiles(files) {
  for (const f of files) {
    const p = window.pet.pathForFile(f);
    if (p) pushAttachment({ kind: 'path', path: p, name: p.split(/[\\/]/).filter(Boolean).pop() || f.name });
    else if (f.type.startsWith('image/')) addImageFile(f);
  }
}

function renderAttachments() {
  const row = $('attach-row');
  row.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = a.kind === 'image' ? 'attach-chip' : 'attach-chip file';
    if (a.kind === 'image') chip.style.backgroundImage = `url(${a.dataUrl})`;
    else { chip.title = a.path; chip.innerHTML = `<span class="ico">📄</span><span class="nm"></span>`; chip.querySelector('.nm').textContent = a.name; }
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = '移除';
    x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    chip.appendChild(x);
    row.appendChild(chip);
  });
  row.classList.toggle('hidden', attachments.length === 0);
}

async function release(deleteAgent) {
  await window.pet.release({ deleteAgent });
  view = null;
  showOnboarding();
}

// ---------- render loop ----------
// What the pet is doing right now, in the shared state vocabulary (src/core/fx.js STATES), by priority:
// lifted or flying > waking up / stage-up > thinking > eating > a one-shot (click, play, idle cue, error)
// > talking > its needs (idle / happy / sad / hungry / sleep).
const CELEBRATIONS = ['hatch', 'evolve'];
// a rig acts every state out itself, but has no food, thought bubble or z's to draw: those keep their emoji
const RIG_OVERLAY = new Set(['eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'sleep', 'hungry']); // waking up and a stage-up play through, even while it thinks
function petStatus() {
  const now = performance.now();
  if (fx.lifted || fx.flying) return 'lifted';
  const shot = fx.current(now);
  if (shot && CELEBRATIONS.includes(shot)) return shot;
  if (thinking) return 'think';
  if (eating) return `eat_${eating}`;
  if (shot) return shot;
  if (fx.walking) return 'walk';
  if (now < talkUntil) return 'talk';
  return view.status;
}
const petAction = () => petStatus();

// Every frame, for every character: pick the state, resolve it against the character's art, play it.
function animatePet() {
  const now = performance.now();
  const sp = speciesOf(view.pet.speciesId);
  const video = isVideo(view.pet.speciesId);
  fx.tickIdle(now, ['idle', 'happy'].includes(petStatus()) && !pointerInside, video);
  const state = petStatus();
  const r = state.startsWith('touch-') ? { name: state, exact: true } : video ? clipFor(sp, state) : view.look && view.look.kind === 'sprites' ? Fx.resolveAction(state, (n) => !!view.look.actions[n]) : isLive(view.look) ? { name: state, exact: !RIG_OVERLAY.has(state) } : { name: state, exact: false };
  if (video) playClip($('pet-video'), sp, r.name);
  const wrap = $('char-wrap');
  if (wrap.dataset.status !== state) wrap.dataset.status = state; // pictures move with CSS (style.css)
  // an emoji over a character that has no own art for the state (a sprite or clip draws its own)
  const fxText = r.exact ? '' : Fx.FOOD_OVERLAY[state] || Fx.OVERLAY[state] || '';
  if ($('char-fx').textContent !== fxText) $('char-fx').textContent = fxText;
  fx.render(state, r.name, r.exact, sp.fx.noMirror);
  $('pet-body').classList.toggle('flash', now < flashUntil);
  if (now - lastPose > 1000 && !fx.flying) { lastPose = now; fx.report(0, 0); } // where it is, for the others' collisions
}
let lastPose = 0;

// Test and debugging handle: what the pet is doing, and cues to trigger every effect by hand.
// ---------- 语音输入 (recognition runs in main: core/asr.js; docs/asr-design.md §5–7) ----------
// 🎤 next to the chat box, shown while 语音输入 is on. A quick click starts and a second click stops; holding
// it down records until it is let go (按住说话). Esc cancels. MediaRecorder's webm/opus goes to main over IPC
// (window.pet.asr.transcribe); the text lands in the chat box, or is sent at once (识别后直接发送).
const MIC_MIN_MS = 400; // shorter than this is a slip of the finger, not something said
const MIC_HOLD_MS = 350; // held longer than this: 按住说话 (letting go stops); shorter: a click that toggles
const CHAT_PLACEHOLDER = '说点什么，可粘贴图片、拖入文件…';
const ASR_NAME = { lobehub: 'LobeHub 云端识别', local: '本地识别服务（whisper）' };
const ASR_REASON = {
  'too-short': '太短了，没录到。点一下 🎤 开始、说完再点一下；或者按住 🎤 说话。',
  empty: '没听清，再说一遍？',
  unauthorized: '语音识别要先登录 LobeHub。',
  model: '识别模型用不了，去 高级设置 → 语音输入 换一个。',
  'no-lh': '没找到能识别语音的 lh（需要较新的 LobeHub CLI）。',
  network: '连不上本地识别服务',
  timeout: '识别超时了。',
  server: '识别服务出错了。',
  'bad-audio': '这段录音没法识别。',
  'not-configured': '语音输入没开，或者没选识别引擎。',
  'mic-denied': '没有麦克风权限。macOS：系统设置 → 隐私与安全性 → 麦克风，允许本应用；Windows：设置 → 隐私 → 麦克风。',
  'no-mic': '没找到麦克风。',
  'mic-error': '麦克风打不开',
  canceled: '已取消。',
};
let mic = { state: 'idle', rec: null, stream: null, chunks: [], t0: 0, ms: 0, timer: null, tick: null, pressAt: 0, cancel: false };
let lastAsr = null; // the last outcome (e2e reads it through petFx.lastAsr)
const asrOn = () => !!(settings && settings.asr && settings.asr.enabled && settings.asr.engine !== 'off');
const micActive = () => mic.state !== 'idle';

function asrReasonText(r) {
  const base = ASR_REASON[r.reason] || (String(r.reason || '').startsWith('http-') ? `识别服务返回了错误 ${r.reason.slice(5)}。` : `识别失败（${r.reason || '未知原因'}）。`);
  if (r.reason === 'network') return `${base}：${(settings && settings.asr && settings.asr.local.endpoint) || ''}。它开着吗？`;
  if (r.reason === 'mic-error') return `${base}（${String(r.message || '').slice(0, 60)}）。`;
  return base;
}

// The 🎤 button, the status line above the box and the box itself follow mic.state.
function paintMic() {
  const b = $('chat-mic');
  if (!b) return;
  const input = $('chat-input');
  const st = $('mic-status');
  const s = mic.state;
  b.dataset.state = s;
  b.setAttribute('aria-pressed', String(s === 'recording'));
  const sec = s === 'recording' ? Math.floor((performance.now() - mic.t0) / 1000) : 0;
  const max = (settings && settings.asr && settings.asr.maxSeconds) || 60;
  if (s === 'recording') b.textContent = `■ ${sec}s`;
  else if (s === 'idle') b.textContent = '🎤';
  else b.innerHTML = '<span class="spin" aria-hidden="true"></span>';
  b.title = s === 'recording' ? '再点一下（或松开）结束，Esc 取消' : s === 'idle' ? '语音输入：点一下开始、再点一下结束；也可以按住说话，松开结束' : '识别中…';
  input.classList.toggle('listening', s === 'recording');
  input.classList.toggle('recognizing', s === 'transcribing' || s === 'stopping');
  input.placeholder = s === 'recording' ? '正在听…' : s === 'transcribing' || s === 'stopping' ? '识别中…' : CHAT_PLACEHOLDER;
  const engine = settings && settings.asr ? ASR_NAME[settings.asr.engine] || '' : '';
  const line = s === 'recording' ? `🔴 正在听 ${sec}s / ${max}s · 再点或松开结束，Esc 取消`
    : s === 'starting' ? '🎤 正在打开麦克风…'
      : s === 'stopping' || s === 'transcribing' ? `⏳ 识别中…（${engine}）` : '';
  st.textContent = line;
  st.dataset.state = s;
  st.classList.toggle('hidden', !line);
}

// Shown or hidden with 语音输入; switching it off mid-recording drops the recording.
function syncMic() {
  const b = $('chat-mic');
  if (!b) return;
  const on = asrOn() && !VISITOR;
  b.classList.toggle('hidden', !on);
  if (!on && micActive()) micStop(true);
}

function micRelease() {
  clearTimeout(mic.timer);
  clearInterval(mic.tick);
  if (mic.stream) for (const t of mic.stream.getTracks()) t.stop(); // the OS's microphone light goes off
  mic.stream = null;
  mic.rec = null;
  mic.chunks = [];
}

async function micStart() {
  if (mic.state !== 'idle' || !asrOn() || thinking) return;
  mic.state = 'starting';
  paintMic();
  syncHover();
  try {
    const access = await window.pet.asr.micAccess();
    if (access !== 'granted') throw Object.assign(new Error(access), { name: 'NotAllowedError' });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (mic.state !== 'starting') { for (const t of stream.getTracks()) t.stop(); return; } // let go / Esc while it opened
    const type = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : {});
    mic.stream = stream;
    mic.rec = rec;
    mic.chunks = [];
    mic.cancel = false;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) mic.chunks.push(e.data); };
    rec.onstop = () => { micDone(rec); };
    rec.start(250);
    mic.t0 = performance.now();
    mic.state = 'recording';
    stopSpeech('listening'); // her own voice must not end up in the recording
    mic.tick = setInterval(paintMic, 250);
    mic.timer = setTimeout(() => micStop(), ((settings.asr && settings.asr.maxSeconds) || 60) * 1000);
    paintMic();
  } catch (e) {
    micRelease();
    mic.state = 'idle';
    paintMic();
    syncHover();
    const n = e && e.name;
    asrFail({ ok: false, reason: n === 'NotAllowedError' || n === 'SecurityError' ? 'mic-denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'no-mic' : 'mic-error', message: String((e && e.message) || e) });
  }
}

// Stop listening: the clip goes to be recognised, or (cancel) is thrown away.
function micStop(cancel = false) {
  if (mic.state === 'starting') { mic.state = 'idle'; paintMic(); syncHover(); return; }
  if (mic.state !== 'recording') {
    if (cancel && mic.state === 'transcribing') window.pet.asr.cancel();
    return;
  }
  mic.cancel = cancel;
  mic.ms = performance.now() - mic.t0;
  clearTimeout(mic.timer);
  clearInterval(mic.tick);
  mic.state = 'stopping';
  paintMic();
  try { mic.rec.stop(); } catch { micDone(mic.rec); }
}

async function micDone(rec) {
  if (rec && mic.rec !== rec) return;
  const chunks = mic.chunks;
  const mime = (rec && rec.mimeType) || 'audio/webm';
  const ms = Math.round(mic.ms || 0);
  const cancel = mic.cancel;
  micRelease();
  if (cancel) { mic.state = 'idle'; paintMic(); syncHover(); lastAsr = { ok: false, reason: 'canceled', clipMs: ms }; return; }
  if (ms < MIC_MIN_MS || !chunks.length) { mic.state = 'idle'; paintMic(); syncHover(); asrFail({ ok: false, reason: 'too-short', clipMs: ms }); return; }
  const blob = new Blob(chunks, { type: mime });
  mic.state = 'transcribing';
  paintMic();
  let r;
  try {
    r = await window.pet.asr.transcribe(await blob.arrayBuffer(), mime, ms);
  } catch (e) {
    r = { ok: false, reason: 'server', message: String((e && e.message) || e) };
  }
  mic.state = 'idle';
  paintMic();
  syncHover();
  lastAsr = { ...r, bytes: blob.size, mime, clipMs: ms, at: Date.now() };
  if (!r.ok) { if (r.reason !== 'canceled') asrFail(r); return; }
  const input = $('chat-input');
  const cur = input.value.trimEnd();
  input.value = `${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${r.text}`.slice(0, Number(input.maxLength) > 0 ? Number(input.maxLength) : 400);
  if (!$('chat-row').classList.contains('hidden')) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  if (settings.asr.autoSend) {
    if (thinking) showNotice('🎤 已填进输入框', '她还在回上一句，等她说完再点“发送”。');
    else { lastAsr.sent = true; $('chat-send').click(); }
  }
}

// What went wrong goes in a toast; what is in the box stays.
function asrFail(r) {
  lastAsr = { ...(lastAsr && lastAsr.at === r.at ? lastAsr : {}), ...r };
  const settingsFix = !/^(too-short|empty|canceled|mic-denied|no-mic)$/.test(r.reason);
  showNotice('🎤 语音输入没成功', asrReasonText(r), settingsFix ? { label: '去设置', panel: 'advanced', scroll: 'asr-section' } : null);
}

// A short notice in the toast box (the one 关系升级 uses): title, one line, optionally a button to a panel.
function showNotice(title, text, action = null, ms = 8000) {
  $('unlock-toast').classList.add('notice');
  $('toast-title').textContent = title;
  $('toast-body').textContent = text;
  const open = $('toast-open');
  open.classList.toggle('hidden', !action);
  open.textContent = action ? action.label : '';
  open.dataset.panel = action ? action.panel : '';
  open.dataset.scroll = action ? action.scroll || '' : '';
  $('unlock-toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function bindMic() {
  const b = $('chat-mic');
  b.addEventListener('mousedown', (e) => e.preventDefault()); // the chat box keeps the focus
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (mic.state === 'recording') { mic.pressAt = 0; micStop(); return; } // the second click
    if (mic.state !== 'idle') return;
    try { b.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    mic.pressAt = performance.now();
    micStart();
  });
  const release = () => {
    const held = mic.pressAt && performance.now() - mic.pressAt > MIC_HOLD_MS;
    mic.pressAt = 0;
    if (held) micStop(); // 按住说话: letting go ends it. A quick click keeps listening until the next one.
  };
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  // Enter / Space on the focused button: start, and stop
  b.addEventListener('click', (e) => { if (e.detail !== 0) return; if (mic.state === 'recording') micStop(); else micStart(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && micActive()) { e.stopImmediatePropagation(); micStop(true); } }, true);
  syncMic();
  paintMic();
}

// 高级设置 → 语音输入 (core/asr.js settings.asr): on/off, the engine, LobeHub's model, the local whisper
// server (address, API shape, model, its optional key), language, falling back, 识别后直接发送, and 测试连接.
const ASR_LANGS = [['auto', '自动识别'], ['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский']];
const ASR_ERR = { 'bad-endpoint': '地址要是 https://，或者本机 / 局域网的 http://（如 http://127.0.0.1:8179、http://192.168.1.5:8179）。', 'bad-model': '模型名只能有字母、数字和 . _ : / -（最多 80 个字符）。', 'bad-language': '语言要是两个字母的代码，比如 zh、en。', 'bad-engine': '没有这个引擎。', 'bad-key': '这不像一个 API Key（不能有空格，8–256 个字符）。' };
function asrSection() {
  const a = settings.asr;
  const sec = document.createElement('div');
  sec.className = 'adv-section';
  sec.id = 'asr-section';
  sec.innerHTML = '<h3>语音输入</h3><p class="adv-text">打开后聊天框旁边出现 🎤：点一下开始说、再点一下结束，或者按住说话、松开结束（Esc 取消，最长 <span class="asr-max"></span> 秒）。只在你按 🎤 的时候录音，不常驻监听。“LobeHub 云端识别”把录音发到 LobeHub 转成文字（用你登录的账号，按 Credits 计费）；“本地识别服务”只把录音发到你填的地址（比如本机跑的 whisper.cpp <code>whisper-server</code>），不经过云端。录音不写进日志，用完就删。</p>'
    + '<label class="pref-row"><input type="checkbox" id="asr-on" /><span><b>开启语音输入</b><small>第一次录音时系统会问一次麦克风权限。</small></span></label>'
    + '<div class="size-row"><span>引擎</span><select id="asr-engine"><option value="lobehub">LobeHub 云端识别</option><option value="local">本地识别服务（whisper）</option><option value="off">关闭</option></select></div>'
    + '<div class="size-row"><span>语言</span><select id="asr-language"></select></div>'
    + '<label class="pref-row"><input type="checkbox" id="asr-autosend" /><span><b>识别后直接发送</b><small>不勾时文字先填进输入框，改好再按“发送”。</small></span></label>'
    + '<label class="pref-row"><input type="checkbox" id="asr-fallback" /><span><b>用不了时换另一个引擎</b><small>选的引擎出错、超时或连不上时，这一句改用另一个再试一次。</small></span></label>'
    + '<div class="tts-engine" id="asr-lobehub"><b>LobeHub 云端识别</b><small class="adv-note">用这台电脑上登录的 lh 账号。gpt-4o-mini-transcribe 快、便宜；gpt-4o-transcribe 更准。</small><div class="size-row"><span>模型</span><select id="asr-lobehub-model"><option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option><option value="gpt-4o-transcribe">gpt-4o-transcribe</option></select></div></div>'
    + '<div class="tts-engine" id="asr-local"><b>本地识别服务（whisper）</b><small class="adv-note">你自己在本机或局域网电脑上跑的语音识别服务。whisper.cpp：<code>whisper-server -m models/ggml-base.bin --port 8179 --convert --inference-path /v1/audio/transcriptions</code>（--convert 需要 ffmpeg），接口选“OpenAI 兼容”；用默认 /inference 启动时选“whisper.cpp”。faster-whisper-server / speaches 等 OpenAI 兼容的服务也可以。</small>'
    + '<div class="size-row"><span>地址</span><input type="text" id="asr-endpoint" spellcheck="false" placeholder="http://127.0.0.1:8179" /></div>'
    + '<div class="size-row"><span>接口</span><select id="asr-local-api"><option value="openai">OpenAI 兼容（/v1/audio/transcriptions）</option><option value="whispercpp">whisper.cpp（/inference）</option></select></div>'
    + '<div class="size-row"><span>模型</span><input type="text" id="asr-local-model" spellcheck="false" placeholder="whisper-1" /><button id="asr-local-save" class="btn">保存</button></div>'
    + '<div class="size-row"><input type="password" id="asr-key" autocomplete="off" spellcheck="false" placeholder="Key（服务不要就不填）" /><button id="asr-key-save" class="btn">保存</button><button id="asr-key-del" class="btn">清除</button></div></div>'
    + '<div class="size-row"><button id="asr-test" class="btn">测试连接</button></div><p class="adv-note" id="asr-test-result"></p><p class="adv-note" id="asr-status"></p>';
  const $s = (id) => sec.querySelector(`#${id}`);
  const lang = $s('asr-language');
  for (const [v, l] of ASR_LANGS) lang.insertAdjacentHTML('beforeend', `<option value="${v}">${l}</option>`);
  const paint = () => {
    const s = settings.asr;
    $s('asr-on').checked = s.enabled;
    $s('asr-engine').value = s.engine;
    lang.value = ASR_LANGS.some((x) => x[0] === s.language) ? s.language : 'auto';
    $s('asr-autosend').checked = s.autoSend;
    $s('asr-fallback').checked = s.fallback;
    $s('asr-lobehub-model').value = s.lobehub.model;
    $s('asr-local-api').value = s.local.api;
    sec.querySelector('.asr-max').textContent = String(s.maxSeconds);
    // the box of the engine in use first; the other one stays reachable when falling back is on
    $s('asr-lobehub').classList.toggle('dim', s.engine !== 'lobehub' && !s.fallback);
    $s('asr-local').classList.toggle('dim', s.engine !== 'local' && !s.fallback);
    const st = settings.asrStatus || {};
    const parts = [s.enabled && s.engine !== 'off' ? `正在用：${ASR_NAME[s.engine]}${s.fallback ? '（用不了时换另一个）' : ''}` : '语音输入关着'];
    for (const id of ['lobehub', 'local']) if (st[id] && st[id].paused) parts.push(`${ASR_NAME[id]}暂停中（${st[id].reason}），点“测试连接”马上恢复`);
    if (st.local && st.local.hasKey) parts.push('本地服务的 Key 已设置');
    $s('asr-status').textContent = parts.join('；') + '。';
  };
  const apply = async (patch, msg) => {
    const r = await window.pet.asr.set(patch);
    setSettings(r.settings);
    paint();
    panelMsg(r.ok ? msg : ASR_ERR[r.reason] || `没能保存（${r.reason}）。`, r.ok);
    return r.ok;
  };
  const ep = $s('asr-endpoint');
  const model = $s('asr-local-model');
  ep.value = a.local.endpoint;
  model.value = a.local.model;
  $s('asr-on').addEventListener('change', (e) => apply({ enabled: e.target.checked }, e.target.checked ? `语音输入已开启（${ASR_NAME[settings.asr.engine] || '引擎关闭'}）。聊天框旁边的 🎤 就是。` : '语音输入已关闭。'));
  $s('asr-engine').addEventListener('change', (e) => apply({ engine: e.target.value }, `语音识别引擎：${e.target.selectedOptions[0].textContent}。`));
  lang.addEventListener('change', () => apply({ language: lang.value }, `识别语言：${lang.selectedOptions[0].textContent}。`));
  $s('asr-autosend').addEventListener('change', (e) => apply({ autoSend: e.target.checked }, e.target.checked ? '识别后直接发送。' : '识别后先填进输入框。'));
  $s('asr-fallback').addEventListener('change', (e) => apply({ fallback: e.target.checked }, e.target.checked ? '选的引擎用不了时，换另一个再试一次。' : '只用选的引擎。'));
  $s('asr-lobehub-model').addEventListener('change', (e) => apply({ lobehub: { model: e.target.value } }, `LobeHub 识别模型：${e.target.value}。`));
  $s('asr-local-api').addEventListener('change', (e) => apply({ local: { api: e.target.value } }, `本地识别服务接口：${e.target.selectedOptions[0].textContent}。`));
  $s('asr-local-save').addEventListener('click', async () => {
    if (await apply({ local: { endpoint: ep.value, model: model.value } }, `本地识别服务：${ep.value.trim() || '默认地址'}，模型 ${model.value.trim() || settings.asr.local.model}。`)) { ep.value = settings.asr.local.endpoint; model.value = settings.asr.local.model; }
  });
  const key = $s('asr-key');
  $s('asr-key-save').addEventListener('click', async () => {
    if (!key.value.trim()) return panelMsg('先在框里粘贴 Key。');
    if (await apply({ key: key.value }, '本地识别服务的 Key 已保存。')) key.value = '';
  });
  $s('asr-key-del').addEventListener('click', () => apply({ key: '' }, '本地识别服务的 Key 已清除。'));
  $s('asr-test').addEventListener('click', async () => {
    const out = $s('asr-test-result');
    const btn = $s('asr-test');
    // what is in the boxes counts, saved or not: save first so the test goes where the owner is looking
    if (ep.value.trim() !== settings.asr.local.endpoint || (model.value.trim() || settings.asr.local.model) !== settings.asr.local.model) {
      if (!(await apply({ local: { endpoint: ep.value, model: model.value } }, '已保存本地识别服务的地址和模型。'))) return;
    }
    btn.disabled = true;
    out.textContent = '⏳ 正在测试…（发一段 0.6 秒的静音）';
    const r = await window.pet.asr.test();
    btn.disabled = false;
    out.textContent = r.results && r.results.length
      ? r.results.map((x) => `${x.ok ? '✅' : '❌'} ${ASR_NAME[x.provider]}：${x.ok ? `能用（${x.ms} ms）` : asrReasonText({ reason: x.reason, message: x.message })}`).join('　')
      : `❌ ${asrReasonText({ reason: r.reason || 'not-configured' })}`;
    out.dataset.ok = String(!!r.ok);
    setSettings(await window.pet.getSettings());
    paint();
  });
  paint();
  return sec;
}

window.petFx = {
  state: () => (view ? { state: petStatus(), action: $('pet-body').dataset.action, exact: $('pet-body').dataset.exact === 'yes', facing: $('pet-body').dataset.facing, lastCue: fx.lastCue, flying: fx.flying, species: view.pet.speciesId, video: isVideo(view.pet.speciesId) } : null),
  cue: (name) => fx.cue(name, isVideo(view.pet.speciesId)),
  click: () => doAct('pat'),
  // 部位触摸: what a client point maps to, and the last reaction shown
  touchPoint: (cx, cy) => { const { zone, pt } = zoneAtClient(cx, cy); return pt ? { zone, x: pt.x, y: pt.y, opaque: pt.opaque, pose: pt.pose, mirrored: pt.mirrored, box: pt.box } : null; },
  lastTouch: () => lastTouch,
  throw: (vx, vy) => throwPet({ vx, vy }),
  burst: (n) => fx.burst(n),
  error: () => say('（出错了：测试）', 'error', 'error', 'test'),
  eat: (food) => { eating = food; setTimeout(() => { eating = null; }, 4000); },
  lift: (on) => fx.setLifted(on),
  face: (dir) => fx.setFacing(dir),
  walk: () => fx.walkPet(),
  stats: () => ({ ...fx.stats, walking: fx.walking }),
  hitBox: () => petHitBox(),
  lastSpeech: () => lastSpeech && { ...lastSpeech, fellBackFrom: [...lastSpeech.fellBackFrom], sentences: lastSpeech.sentences.map((s) => ({ ...s })) },
  speechLog: () => speechLog.map((e) => ({ ...e })),
  audioState: () => (speechAudio ? { paused: speechAudio.paused, currentTime: speechAudio.currentTime, duration: speechAudio.duration, src: speechAudio.src.slice(0, 5) } : null),
  speak: (text) => speak({ text, source: 'api', kind: 'api' }),
  // 互动语音: every line offered to the voice (said or dropped by the gate), and the last prewarm
  offerLog: () => offerLog.map((e) => ({ ...e })),
  speechGate: () => ({ ...speechGate.stats }),
  lastPrewarm: () => lastPrewarm && { ...lastPrewarm },
  lastAsr: () => lastAsr && { ...lastAsr },
  micState: () => mic.state,
  // VRM figures (vrm.js): what each is drawing (mode, fps, face, mouth, gaze…), created / disposed counts
  vrm: () => (window.PetVRM ? window.PetVRM.debug() : null),
  // e2e: a few seconds of vowel-like sound played through the TTS path (playAudio), so lip sync runs
  // without a TTS engine; resolves with how the clip ended
  testVoice: (seconds = 2) => new Promise((resolve) => {
    const rec = { sentences: [], fellBackFrom: [] };
    const s = { text: '测试口型', status: 'queued' };
    playAudio(rec, s, { ok: true, provider: 'test', audio: vowelWav(seconds), mime: 'audio/wav', cached: false }, (status) => resolve(status));
  }),
};
// A WAV of `seconds` of vowel-like tones (a voice pitch plus two formant partials, a new vowel every 250 ms
// with a short pause between), for petFx.testVoice.
function vowelWav(seconds) {
  const rate = 22050;
  const n = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  const VOWELS = [[850, 1600], [300, 2600], [350, 800], [500, 2200], [550, 900]]; // a i u e o (F1, F2)
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const [f1, f2] = VOWELS[Math.floor(t / 0.25) % VOWELS.length];
    const ph = (t % 0.25) / 0.25;
    const env = ph < 0.8 ? Math.sin((ph / 0.8) * Math.PI) : 0;
    const x = 0.3 * Math.sin(2 * Math.PI * 180 * t) + 0.35 * Math.sin(2 * Math.PI * f1 * t) + 0.25 * Math.sin(2 * Math.PI * f2 * t);
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x * env)) * 32767 * 0.8, true);
  }
  return buf;
}

// The local HTTP API (src/core/api.js) asks the window to play, throw or report what it is doing.
async function onApiCmd({ id, cmd, args }) {
  let result = { ok: false, reason: 'no-pet' };
  if (view && !$('pet-screen').classList.contains('hidden')) {
    const video = isVideo(view.pet.speciesId);
    if (cmd === 'state') result = { ok: true, fx: window.petFx.state(), bubble: $('bubble').classList.contains('hidden') ? null : $('bubble').textContent };
    if (cmd === 'anim') {
      if (thinking) result = { ok: false, reason: 'busy' };
      else {
        if (args.facing) fx.setFacing(args.facing);
        fx.cue(args.state, video);
        result = { ok: true };
      }
    }
    if (cmd === 'throw') {
      const r = await throwPet({ vx: args.vx, vy: args.vy });
      result = r ? { ok: true, bounces: r.bounces } : { ok: false, reason: 'flying' };
    }
  }
  window.pet.apiReply(id, result);
}

function frameLoop() {
  tickSprites(performance.now());
  tickRigs(performance.now());
  if (!$('hatching').classList.contains('hidden')) {
    $('hatch-look').classList.toggle('flash', performance.now() < flashUntil);
  } else if (view && !$('pet-screen').classList.contains('hidden')) {
    animatePet();
  }
  // ~12 fps keeps the pixel feel and idles cheaply; a rig's springs want every frame
  if (rigs.size) requestAnimationFrame(frameLoop);
  else setTimeout(() => requestAnimationFrame(frameLoop), 80);
}

// ---------- updates (src/main/updater.js) ----------
let updateAnnounced = null;
let updateState = null;
function onUpdateStatus(u) {
  updateState = u;
  if (panelKind === 'advanced') renderUpdateSection();
  const b = $('menu-update');
  const label = { downloading: `正在下载新版本 v${u.version}…`, ready: `立即更新到 v${u.version} 并重启`, manual: `下载新版本 v${u.version}` }[u.status];
  b.classList.toggle('hidden', !label);
  b.disabled = u.status === 'downloading';
  if (label) b.textContent = label;
  if (!view || updateAnnounced === `${u.status}:${u.version}`) return;
  const moveFirst = ['translocated', 'dmg', 'read-only'].includes(u.error);
  if (u.status === 'ready') say(`（新版本 v${u.version} 已经下载好了。你离开电脑一会儿时我会自己重启更新，也可以在 ⋯ 菜单里立即更新。）`, 'update', 'fallback');
  else if (u.status === 'manual') say(moveFirst ? `（有新版本 v${u.version}。先把我拖进“应用程序”文件夹再打开，以后就能自动更新了；这次可以在 ⋯ 菜单里下载。）` : `（有新版本 v${u.version}，可以在 ⋯ 菜单里下载。）`, 'update', 'fallback');
  else return;
  updateAnnounced = `${u.status}:${u.version}`;
}

// ---------- boot ----------
async function main() {
  fx = window.PetEffects.createEffects({ body: $('pet-body'), floatLayer: $('float-layer'), touchLayer: $('touch-fx'), api: window.pet, prefs: petPrefs, hitBox: petHitBox });
  window.pet.onKicked((v) => fx.kicked(v, { onLand: () => fx.play('pat', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'pat')) }));
  if (VISITOR) return visitorMain();
  info = await window.pet.boot();
  bindPetUi();
  bindResize();
  bindHover();
  $('hatch-btn').addEventListener('click', startHatch);
  $('hatch-retry').addEventListener('click', showOnboarding);
  $('age-yes').addEventListener('click', () => answerAgeGate(true));
  $('age-no').addEventListener('click', () => answerAgeGate(false));
  $('panel-close').addEventListener('click', closePanel);
  $('toast-close').addEventListener('click', hideToast);
  $('toast-open').addEventListener('click', async () => {
    const { panel, scroll } = $('toast-open').dataset;
    hideToast();
    await openPanel(panel || 'wardrobe');
    const el = scroll && document.getElementById(scroll);
    if (el) el.scrollIntoView({ block: 'start' });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelKind && !thinking) closePanel(); });
  window.pet.onUpdate((v) => { view = v; syncPrewarm(); if (v) { applyArt(); refreshHud(); if (panelKind === 'advanced' || panelKind === 'characters') renderPanel(); } });
  window.pet.onSay((m) => { say(m.text, m.kind, m.source, m.reason, m.meme); speak(m); });
  window.pet.onApiCmd(onApiCmd);
  window.pet.onThinking(setThinking);
  window.pet.onAffection(onAffection);
  window.pet.onSettings((st) => { setSettings(st); });
  window.pet.onUpdateStatus(onUpdateStatus);
  setSettings(info.settings);
  const start = (v) => (v ? enterPet(v) : showOnboarding());
  if (settings.needsAgeGate) showAgeGate((r) => start(r.view));
  else start(info.view);
  if (info.update) onUpdateStatus(info.update);
  requestAnimationFrame(frameLoop);
}

// A visiting model-chan (同屏伙伴): only the character, with every desktop effect (idle chain, walking,
// clicks, dragging, throwing, knocking into the others) and no agent, needs or controls. Hovering shows
// one button that sends her home.
async function visitorMain() {
  document.body.classList.add('visitor');
  const b = await window.pet.visitorBoot();
  if (!b) return;
  info = { species: b.species, testMode: b.testMode };
  setSettings(b.settings);
  const sp = speciesOf(b.speciesId);
  view = { pet: { speciesId: sp.id, name: sp.nameZh }, look: b.look, outfit: 'daily', status: 'idle' };
  window.pet.onSettings((st) => setSettings(st));
  bindHover();
  bindPetPointer({ onClick: () => { fx.click(isVideo(sp.id)); fx.burst(3); }, onMenu: () => { pointerInside = true; syncHover(); } });
  $('visitor-name').textContent = `${sp.nameZh}（${sp.vendor}）来串门`;
  $('visitor-close').addEventListener('click', () => window.pet.setVisitors(settings.visitors.filter((v) => v !== sp.id)));
  show('pet-screen');
  applyArt();
  requestAnimationFrame(frameLoop);
}

main();
