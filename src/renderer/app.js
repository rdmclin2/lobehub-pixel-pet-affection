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
let settings = null; // latest settings view: { needsAgeGate, ageConfirmed, adultContent, ... }
let gateAfter = null; // what to do once the age gate is answered
let panelKind = null; // 'wardrobe' | 'topics' while a panel is open
let panelNew = new Set(); // items that were "new" when the panel opened (marked seen right after)
let toastTimer = null;
const notedBlocks = new Set(); // "cooldown" / "cap" notes are shown once per launch

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
  settings = r.settings;
  const after = gateAfter;
  gateAfter = null;
  if (after) after(r);
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
  return { fire: '🔥 火之灵石', water: '💧 水之灵石', grass: '🌱 草之灵石', whale: '🐋 鲸之灵石' }[el] || el;
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
  $('egg-info').textContent = '点一块灵石看看。';
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
  const res = await window.pet.hatch(species.id, $('pet-name').value, $('local-opt').checked);
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
  // 💗 affection: stage name in its colour, the 0..100 bar and the number; the tooltip has the stage progress
  $('aff-stage').textContent = a.stageName;
  $('aff-stage').style.setProperty('--sc', a.color);
  $('bar-affection').style.setProperty('--v', `${a.value}%`);
  $('bar-affection').style.setProperty('--c', a.color);
  $('aff-num').textContent = `♥${a.value}/${a.max}`;
  $('aff-row').title = a.next ? `好感 ${a.value} / ${a.max} · 距「${a.nextName}」还差 ${a.need}（本阶段进度 ${a.pct}%）` : `好感 ${a.value} / ${a.max} · 已满级`;
  $('aff-row').setAttribute('aria-label', $('aff-row').title);
  $('btn-wardrobe').querySelector('.new-dot').classList.toggle('hidden', !view.outfits.some((o) => o.isNew));
  $('btn-topics').querySelector('.new-dot').classList.toggle('hidden', !view.topics.some((o) => o.isNew));
  settings = view.settings;
  $('menu-adult').textContent = !settings.ageConfirmed ? '成人向内容：关（需年满 18 岁）' : `成人向内容：${settings.adultContent ? '开（点此关闭）' : '关（点此开启）'}`;
  const worn = view.outfits.find((o) => o.id === view.outfit);
  $('outfit-badge').textContent = `👗 ${worn ? worn.label : ''}`;
  $('outfit-badge').title = `当前服饰：${worn ? worn.label : ''}`;
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
    if (e.delta > 0) floatText(`+${e.delta} ♥`);
    else if (e.delta < 0) floatText(`${e.delta} ♥`, 'minus');
    else if (BLOCK_NOTES[e.blocked] && !notedBlocks.has(e.blocked)) {
      notedBlocks.add(e.blocked);
      floatText(BLOCK_NOTES[e.blocked], 'note');
    }
  } else if (e.type === 'decay') {
    floatText(`${e.delta} ♥（好久不见）`, 'minus');
  } else if (e.type === 'stage-up') {
    flashUntil = performance.now() + 700;
    if (e.view) { view = e.view; refreshHud(); }
    showUnlockToast(e);
  }
}

// A stage-up names everything it unlocked, and stays until closed (or for half a minute).
function showUnlockToast(e) {
  const a = (e.view || view).affection;
  const names = (list) => (list && list.length ? list.map((x) => `「${x.label}」`).join('、') : '无');
  $('toast-title').textContent = `🎉 关系升级：${a.stageName}（♥${a.value}）`;
  const body = $('toast-body');
  body.innerHTML = '';
  for (const [k, list] of [['解锁话题', e.unlocks && e.unlocks.topics], ['解锁服饰', e.unlocks && e.unlocks.outfits]]) {
    const line = document.createElement('div');
    line.innerHTML = '<b></b>';
    line.querySelector('b').textContent = `${k}：`;
    line.appendChild(document.createTextNode(names(list)));
    body.appendChild(line);
  }
  $('unlock-toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 30000);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('unlock-toast').classList.add('hidden');
}

// ---------- wardrobe and topics (design 9.5, 9.6) ----------
function drawFigure(canvas, outfitId, speciesId, scale) {
  canvas.width = S.FIG.w * scale;
  canvas.height = S.FIG.h * scale;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  S.drawGrid(ctx, S.figure(outfitId), (k) => S.figureColor(outfitId, speciesId, k), scale);
}

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
  const list = kind === 'wardrobe' ? view.outfits : view.topics;
  panelNew = new Set(list.filter((x) => x.isNew).map((x) => x.id));
  window.pet.panel(true);
  panelMsg('');
  $('panel').classList.remove('hidden');
  renderPanel();
  await window.pet.markSeen(kind === 'wardrobe' ? 'outfit' : 'topic');
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
  pv.innerHTML = '<canvas></canvas><div class="nm"></div><div class="adult-note">当前穿着 · 成年（25+）</div>';
  drawFigure(pv.querySelector('canvas'), worn.id, view.pet.speciesId, 3);
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
    card.innerHTML = '<canvas></canvas><div class="nm"></div><div class="st"></div>';
    drawFigure(card.querySelector('canvas'), o.id, view.pet.speciesId, 2);
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
  const r = await window.pet.talkTopic(t.id);
  if (!r.ok && r.reason === 'busy') say('等等，我还在想上一句……', 'busy');
  if (!r.ok && r.reason === 'canceled') say('（好吧，不聊了。）', 'canceled', 'fallback');
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
    else if (act === 'wardrobe' || act === 'topics') openPanel(act);
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
  const f = S.frame({ speciesId: p.speciesId, status, t, talking: performance.now() < talkUntil, eating, outfit: view.outfit });
  const colorOf = (k) => S.colorFor(p.speciesId, k, view.outfit);
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
      const f = S.frame({ speciesId: revealSpecies, status: 'happy', t, outfit: 'daily' });
      S.drawGrid(ctx, f.grid, (k) => S.colorFor(p.speciesId, k, 'daily'), 8, 0, f.dy * 8);
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
  $('age-yes').addEventListener('click', () => answerAgeGate(true));
  $('age-no').addEventListener('click', () => answerAgeGate(false));
  $('panel-close').addEventListener('click', closePanel);
  $('toast-close').addEventListener('click', hideToast);
  $('toast-open').addEventListener('click', () => openPanel('wardrobe'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelKind && !thinking) closePanel(); });
  window.pet.onUpdate((v) => { view = v; if (v) { applyArt(); refreshHud(); } });
  window.pet.onSay((m) => say(m.text, m.kind, m.source, m.reason));
  window.pet.onThinking(setThinking);
  window.pet.onAffection(onAffection);
  window.pet.onSettings((st) => { settings = st; });
  settings = info.settings;
  const start = (v) => (v ? enterPet(v) : showOnboarding());
  if (settings.needsAgeGate) showAgeGate((r) => start(r.view));
  else start(info.view);
  requestAnimationFrame(frameLoop);
}

main();
