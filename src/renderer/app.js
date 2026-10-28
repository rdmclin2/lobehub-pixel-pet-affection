'use strict';

const S = window.Sprites;
const $ = (id) => document.getElementById(id);
const FOOD_SPRITE = { rice: 'rice', cookie: 'cookie', fruit: 'fruit' };
const CREDITS = [
  '大肥鱼动画来自开源项目 dsh-pet（PC2005-cloud）：',
  'https://github.com/PC2005-cloud/dsh-pet',
  '素材仅限非商业使用；形象为社区二创（非 DeepSeek 官方），',
  '授权 CC BY-NC-SA 4.0。原型「溟月」：B站 @上善无形；',
  'DeepSeek 女仆鲸鱼娘设计：B站 @ZipZipPipe。',
].join('\n');

let info = null; // { species[], foods, testMode }
let view = null; // latest pet view from main
let selected = null;
let thinking = false;
let eating = null;
let talkUntil = 0;
let flashUntil = 0;
let hatchCracks = 0;
let revealSpecies = null;
let bubbleTimer = null;
let bubbleHold = false; // pointer over the bubble: keep it open so a long reply can be scrolled and read
let thinkTimer = null;
let attachments = []; // [{ kind:'image', dataUrl, name } | { kind:'path', path, name }] waiting for the next message
let oneShot = null; // { key, until } temporary video clip (pat, play, evolve, hatch)
let pointerInside = false;
let nextLook = 0;

const speciesOf = (id) => info.species.find((s) => s.id === id);
const isVideo = (id) => !!id && speciesOf(id) && speciesOf(id).art === 'video';

function playClip(video, sp, key, loop = true) {
  if (video.dataset.key === key) return;
  video.dataset.key = key;
  video.loop = loop;
  video.src = `assets/${sp.id}/${sp.clips[key]}`;
  video.play().catch(() => {});
}

function startOneShot(key, ms) {
  oneShot = { key, until: performance.now() + ms };
}

function desiredClip() {
  const now = performance.now();
  if (oneShot && now < oneShot.until) return oneShot.key;
  if (thinking) return 'think';
  if (eating) return `eat_${eating}`;
  if (now < talkUntil) return 'talk';
  if (view.status === 'idle' && now > nextLook) {
    nextLook = now + 40000 + Math.random() * 20000;
    startOneShot('look', 5000);
    return 'look';
  }
  return view.status; // idle | happy | sad | hungry | sleep all have a clip
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
}

function eggColor(species) {
  const pal = S.EGG_PAL(species.egg);
  return (k) => pal[k] || S.COMMON[k] || null;
}

function drawEggOn(ctx, species, cracks, scale, dx = 0, dy = 0) {
  S.drawGrid(ctx, S.egg(cracks), eggColor(species), scale, dx, dy);
}

// ---------- onboarding ----------
function buildEggs() {
  const wrap = $('eggs');
  wrap.innerHTML = '';
  for (const sp of info.species) {
    const card = document.createElement('div');
    card.className = 'egg-card';
    card.dataset.species = sp.id;
    card.innerHTML = `<canvas width="120" height="120"></canvas><div class="el">${elementLabel(sp.element)}</div>`;
    card.addEventListener('click', () => selectEgg(sp.id));
    wrap.appendChild(card);
  }
}

function elementLabel(el) {
  return { fire: '🔥 火之蛋', water: '💧 水之蛋', grass: '🌱 草之蛋', whale: '🐋 鲸之蛋' }[el] || el;
}

function selectEgg(id) {
  selected = id;
  const sp = info.species.find((s) => s.id === id);
  for (const c of document.querySelectorAll('.egg-card')) c.classList.toggle('selected', c.dataset.species === id);
  $('egg-info').textContent = `${elementLabel(sp.element)}：${sp.blurb}`;
  $('hatch-btn').disabled = false;
  $('pet-name').placeholder = `给它起个名字（默认 ${sp.nameZh}）`;
}

function showOnboarding() {
  selected = null;
  $('hatch-btn').disabled = true;
  $('egg-info').textContent = '点一颗蛋看看。';
  $('pet-name').value = '';
  buildEggs();
  show('onboarding');
}

// ---------- hatching ----------
const STEP_ORDER = ['checking-login', 'login', 'creating-agent', 'connecting-device', 'hatching'];

function setStep(step) {
  const idx = STEP_ORDER.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  });
  hatchCracks = Math.min(3, Math.max(0, idx > 3 ? 3 : idx));
}

async function startHatch() {
  const species = info.species.find((s) => s.id === selected);
  revealSpecies = null;
  hatchCracks = 0;
  $('hatch-error').classList.add('hidden');
  $('hatch-retry').classList.add('hidden');
  $('login-box').classList.add('hidden');
  $('step-device').classList.toggle('hidden', !$('local-opt').checked);
  $('hatch-title').textContent = '孵化中……';
  document.querySelectorAll('#steps li').forEach((li) => li.classList.remove('done', 'active'));
  show('hatching');

  const offStep = window.pet.onHatchStep(setStep);
  const offLogin = window.pet.onLoginPrompt(({ url, code, browserFailed }) => {
    $('login-msg').textContent = browserFailed ? '没能自动打开浏览器，已为你打开登录页。请输入验证码：' : '浏览器已打开登录页，请确认验证码：';
    $('login-code').textContent = code || '（见浏览器页面）';
    $('login-url').textContent = url;
    $('login-box').classList.remove('hidden');
  });
  const res = await window.pet.hatch(species.id, $('pet-name').value, $('local-opt').checked);
  offStep();
  offLogin();

  if (!res.ok) {
    $('hatch-title').textContent = '孵化失败';
    $('hatch-error').textContent = res.error;
    $('hatch-error').classList.remove('hidden');
    $('hatch-retry').classList.remove('hidden');
    return;
  }
  document.querySelectorAll('#steps li').forEach((li) => { li.classList.remove('active'); li.classList.add('done'); });
  $('login-box').classList.add('hidden');
  flashUntil = performance.now() + 700;
  revealSpecies = res.view.pet.speciesId;
  $('hatch-title').textContent = `${res.view.pet.name} 破壳了！`;
  const sp = speciesOf(revealSpecies);
  if (sp.art === 'video') {
    $('hatch-canvas').classList.add('hidden');
    $('hatch-vwrap').classList.remove('hidden');
    $('hatch-video').dataset.key = '';
    playClip($('hatch-video'), sp, 'hatch', false);
  }
  setTimeout(() => {
    enterPet(res.view);
    if (res.localError) setTimeout(() => say(`（没能连上这台电脑，文件功能先关着：${String(res.localError).slice(0, 60)}）`, 'error', 'fallback', res.localError), 600);
    else if (res.localWarning) setTimeout(() => say(`（${res.localWarning}）`, 'error', 'fallback', res.localWarning), 600);
  }, sp.art === 'video' ? 2800 : 1500);
}

// ---------- pet ----------
function applyArt() {
  const video = isVideo(view && view.pet.speciesId);
  $('pet-canvas').classList.toggle('hidden', video);
  $('vwrap').classList.toggle('hidden', !video);
}

function enterPet(v) {
  view = v;
  revealSpecies = null;
  $('hatch-vwrap').classList.add('hidden');
  $('hatch-canvas').classList.remove('hidden');
  oneShot = null;
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
  $('meta').title = `好感 ${a.value} / ${a.max}（今天 +${a.today} / ${a.dailyCap}）`;
  const loc = view.local && view.local.enabled;
  $('menu-local').textContent = `本机能力：${loc ? '开（点此关闭）' : '关（点此开启）'}`;
}

function say(text, kind, source, reason) {
  const b = $('bubble');
  clearTimeout(bubbleTimer);
  b.classList.remove('thinking');
  b.classList.remove('hidden');
  b.textContent = text;
  b.scrollTop = 0;
  b.dataset.kind = kind || '';
  b.dataset.source = source || '';
  b.dataset.reason = reason || '';
  talkUntil = performance.now() + Math.min(4000, 400 + text.length * 90);
  const hideLater = (ms) => {
    bubbleTimer = setTimeout(() => (bubbleHold ? hideLater(3000) : b.classList.add('hidden')), ms);
  };
  hideLater(Math.min(45000, 6000 + text.length * 150));
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
    b.classList.remove('hidden');
    b.classList.add('thinking');
    let n = 0;
    const tick = () => { b.textContent = `思考中${'.'.repeat((n++ % 3) + 1)}`; };
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
    setTimeout(() => { eating = null; }, video ? 3500 : 1600);
  }
  if (video && r.ok) {
    if (kind === 'pat') startOneShot('pat', 3000);
    if (kind === 'play') startOneShot('play', 4000);
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
    if (act === 'feed') $('food-menu').classList.toggle('hidden');
    else if (act === 'play' || act === 'sleep') doAct(act);
    else if (act === 'chat') {
      $('chat-row').classList.toggle('hidden');
      if (!$('chat-row').classList.contains('hidden')) $('chat-input').focus();
    } else if (act === 'menu') $('main-menu').classList.toggle('hidden');
  });
  $('main-menu').addEventListener('click', async (e) => {
    const m = e.target.dataset && e.target.dataset.menu;
    if (!m) return;
    $('main-menu').classList.add('hidden');
    if (m === 'quit') window.pet.quit();
    if (m === 'log') window.pet.openLog();
    if (m === 'local') {
      const on = !(view && view.local && view.local.enabled);
      if (on && !confirm('让宠物使用这台电脑？\n它可以读写文件、搜索内容、运行命令，能碰到你账号权限内的所有东西（不是沙盒）。')) return;
      const r = await window.pet.setLocal(on);
      if (r.ok) say(on ? '（已连上这台电脑，要我帮你找什么？）' : '（好，我不碰你的电脑了。）', 'local', 'fallback');
      else if (r.reason === 'canceled') say('（好，先不弄了。）', 'canceled', 'fallback');
      else if (r.reason !== 'busy') say(`（没成功：${String(r.message || '未知原因').slice(0, 60)}）`, 'error', 'fallback', r.message);
    }
    if (m === 'credits') alert(CREDITS);
    if (m === 'release' && confirm('放生它，并在 LobeHub 里删除对应的 agent（含聊天记录）？')) await release(true);
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && thinking) window.pet.cancel(); });
  $('stop-btn').addEventListener('click', () => { if (thinking) window.pet.cancel(); });
  $('bubble').addEventListener('mouseenter', () => { bubbleHold = true; });
  $('bubble').addEventListener('mouseleave', () => { bubbleHold = false; });

  // drag the window by the sprite; a click without movement pats the pet
  let drag = null;
  for (const el of document.querySelectorAll('.pet-hit')) {
    el.addEventListener('mousedown', (e) => { drag = { x: e.screenX, y: e.screenY, moved: false }; });
  }
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) { window.pet.moveBy(dx, dy); drag.x = e.screenX; drag.y = e.screenY; }
  });
  window.addEventListener('mouseup', () => {
    if (drag && !drag.moved) doAct('pat');
    drag = null;
  });
}

// Controls are hidden unless the pointer is over the window (or one is in use).
// The controls exist only while the pointer is over the pet window (and it is not working). Nothing
// keeps them open: moving away hides everything, even an open chat box. The draft text and attached
// files are kept and come back with the next hover.
function syncHover() {
  document.body.classList.toggle('over', pointerInside); // pointer over the window (used by the stop button)
  document.body.classList.toggle('hover', !thinking && pointerInside);
  if (!pointerInside) {
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
function drawPet(ctx, t) {
  const p = view.pet;
  const status = thinking ? 'idle' : view.status;
  const f = S.frame({ speciesId: p.speciesId, status, t, talking: performance.now() < talkUntil, eating });
  const colorOf = (k) => S.colorFor(p.speciesId, k);
  const scale = 5;
  S.drawGrid(ctx, f.grid, colorOf, scale, 0, f.dy * scale);
  for (const fx of f.effects) S.drawGrid(ctx, S.EFFECTS[fx.name], (k) => S.colorFor(p.speciesId, k), scale, fx.x * scale, fx.y * scale);
  if (performance.now() < flashUntil) {
    ctx.fillStyle = `rgba(255,255,255,${(flashUntil - performance.now()) / 700})`;
    ctx.fillRect(0, 0, 120, 120);
  }
}

function frameLoop(ts) {
  const t = ts / 1000;
  if (!$('onboarding').classList.contains('hidden')) {
    document.querySelectorAll('.egg-card').forEach((c, i) => {
      const ctx = c.querySelector('canvas').getContext('2d');
      ctx.clearRect(0, 0, 120, 120);
      const sp = info.species[i];
      const wob = c.classList.contains('selected') ? Math.round(Math.sin(t * 9 + i)) * 2 : 0;
      drawEggOn(ctx, sp, 0, 5, wob, 0);
    });
  } else if (!$('hatching').classList.contains('hidden')) {
    const ctx = $('hatch-canvas').getContext('2d');
    ctx.clearRect(0, 0, 192, 192);
    if (revealSpecies) {
      const p = { speciesId: revealSpecies };
      const f = S.frame({ speciesId: revealSpecies, status: 'happy', t });
      S.drawGrid(ctx, f.grid, (k) => S.colorFor(p.speciesId, k), 8, 0, f.dy * 8);
      for (const fx of f.effects) S.drawGrid(ctx, S.EFFECTS[fx.name], (k) => S.colorFor(p.speciesId, k), 8, fx.x * 8, fx.y * 8);
    } else {
      const sp = info.species.find((s) => s.id === selected);
      drawEggOn(ctx, sp, hatchCracks, 8, Math.round(Math.sin(t * 10)) * 4 * (hatchCracks > 0 ? 1 : 0.5), 0);
    }
    if (performance.now() < flashUntil) {
      ctx.fillStyle = `rgba(255,255,255,${(flashUntil - performance.now()) / 700})`;
      ctx.fillRect(0, 0, 192, 192);
    }
  } else if (view) {
    if (isVideo(view.pet.speciesId)) {
      playClip($('pet-video'), speciesOf(view.pet.speciesId), desiredClip());
    } else {
      const ctx = $('pet-canvas').getContext('2d');
      ctx.clearRect(0, 0, 120, 120);
      drawPet(ctx, t);
    }
  }
  setTimeout(() => requestAnimationFrame(frameLoop), 80); // ~12 fps keeps the pixel feel and idles cheaply
}

// ---------- boot ----------
async function main() {
  info = await window.pet.boot();
  bindPetUi();
  bindHover();
  $('hatch-btn').addEventListener('click', startHatch);
  $('hatch-retry').addEventListener('click', showOnboarding);
  window.pet.onUpdate((v) => { view = v; if (v) { applyArt(); refreshHud(); } });
  window.pet.onSay((m) => say(m.text, m.kind, m.source, m.reason));
  window.pet.onThinking(setThinking);
  window.pet.onAffection((a) => {
    if (a.type !== 'stage-up') return;
    flashUntil = performance.now() + 700;
    if (a.view) { view = a.view; refreshHud(); }
  });
  if (info.view) enterPet(info.view);
  else showOnboarding();
  requestAnimationFrame(frameLoop);
}

main();
