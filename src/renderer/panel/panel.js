'use strict';

// 她的面板: draws what her window sends (app.js panelPayload) and hands each pressed button back to it (through
// main: pet-panel:act → panel-act). The window is only as big as the card (it reports its size), so it sits
// right beside her. Keyboard: Tab / Shift+Tab move between the buttons, ←→↑↓ too; Enter / Space press; Esc closes.
// 和她聊天 (T-6162): the chat box is in the card; it has the focus when the panel opens, so typing starts at once.
(() => {
  const $ = (id) => document.getElementById(id);
  const panel = $('pet-panel');
  const input = $('pp-chat-input');
  const sendBtn = $('pp-chat-send');
  const INPUT_MAX_H = 132; // about six lines; past that the box scrolls
  const micBtn = $('pp-chat-mic');
  const hint = $('pp-chat-hint');
  const MIC_ICON = micBtn.innerHTML;
  const HINT = hint.textContent;
  const PLACEHOLDER = input.placeholder;
  let voice = null; // 'on' / 'off' / null (a visitor: no 🎤)
  let micState = 'idle';
  let noteTimer = null;
  let foods = [];

  // the meter fills by transform (no layout work); --v keeps the value as a percentage for anyone reading it
  const setBar = (el, pct, color) => {
    const v = Math.max(0, Math.min(100, pct));
    el.style.setProperty('--v', `${v}%`);
    el.style.setProperty('--k', String(v / 100));
    el.style.setProperty('--c', color);
  };

  function paint(p) {
    document.documentElement.dataset.theme = p.theme === 'dark' ? 'dark' : 'light';
    panel.setAttribute('aria-label', p.summary || '她的状态');
    $('pp-name').textContent = p.name;
    $('pp-char').textContent = p.character;
    $('pp-name').title = `${p.name} · ${p.character}`;
    $('aff-stage').textContent = p.stage;
    $('aff-stage').style.setProperty('--sc', p.stageColor);
    setBar($('bar-affection'), (100 * p.affection.value) / (p.affection.max || 100), p.stageColor);
    $('aff-num').replaceChildren(String(p.affection.value), Object.assign(document.createElement('small'), { textContent: `/${p.affection.max}` }));
    $('aff-row').title = p.affection.title;
    $('aff-row').setAttribute('aria-label', p.affection.title);
    $('meta').textContent = p.progress;
    $('meta').title = p.progressTitle;
    for (const n of p.needs) {
      $(`val-${n.key}`).textContent = String(n.value);
      setBar($(`bar-${n.key}`), n.value, n.color);
      $(`bar-${n.key}`).closest('.need').title = `${n.label} ${n.value} / 100`;
    }
    // the buttons' own state
    const mute = $('btn-mute');
    mute.setAttribute('aria-pressed', String(!!p.mute.pressed));
    mute.setAttribute('aria-label', p.mute.label);
    mute.title = p.mute.title;
    const dance = $('btn-dance');
    dance.classList.toggle('hidden', !p.dance.show);
    dance.setAttribute('aria-pressed', String(!!p.dance.pressed));
    dance.classList.toggle('loading', !!p.dance.loading);
    dance.disabled = !!p.dance.loading;
    dance.title = p.dance.title;
    $('btn-reset').classList.toggle('hidden', !p.reset);
    paintVoice(p.voice); // 🎤: 'on' records here, 'off' leads to 设置 → 语音输入, none for a visitor
    const gear = $('btn-settings');
    gear.querySelector('.new-dot').classList.toggle('hidden', !p.news);
    gear.dataset.news = p.news || '';
    gear.title = p.newsTitle;
    // the foods (built once per list)
    const ids = p.foods.map((f) => f.id).join(',');
    if (ids !== foods.map((f) => f.id).join(',')) {
      foods = p.foods;
      const m = $('food-menu');
      m.replaceChildren(Object.assign(document.createElement('div'), { className: 'pp-foods-title', textContent: '喂她吃什么？' }));
      for (const f of foods) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.dataset.food = f.id;
        b.textContent = f.label;
        m.appendChild(b);
      }
    }
  }

  // the window is as big as the card plus the room for its shadow
  let lastSize = '';
  function report() {
    const r = panel.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(document.body).paddingLeft) || 0;
    const w = Math.ceil(r.width + 2 * pad);
    const h = Math.ceil(r.height + 2 * pad);
    const key = `${w}x${h}`;
    if (key === lastSize) return;
    lastSize = key;
    window.petPanel.size(w, h);
  }
  new ResizeObserver(report).observe(panel);

  function showFoods(on) {
    const m = $('food-menu');
    const show = on === undefined ? m.classList.contains('hidden') : on;
    m.classList.toggle('hidden', !show);
    document.querySelector('[data-act="feed"]').setAttribute('aria-expanded', String(show));
    if (show) { const first = m.querySelector('.btn'); if (first) first.focus({ preventScroll: true }); }
    report();
  }

  // 🎤 (T-6162): her window records (the microphone is hers) and says how it goes (onMic); the panel stays open
  function paintVoice(v) {
    voice = v || null;
    micBtn.classList.toggle('hidden', !voice);
    if (micState === 'idle') micBtn.title = voice === 'off' ? '语音输入还没开：点一下去 设置 → 语音输入 打开' : '语音输入：点一下开始说，再点一下结束';
  }
  function setHint(text, kind) {
    hint.textContent = text || HINT;
    if (kind) hint.dataset.mic = kind; else delete hint.dataset.mic;
  }
  function paintMic(m) {
    micState = m.state || 'idle';
    micBtn.dataset.state = micState;
    micBtn.setAttribute('aria-pressed', String(micState === 'recording'));
    const busy = micState === 'starting' || micState === 'stopping' || micState === 'transcribing';
    if (micState === 'recording') micBtn.textContent = `■ ${m.sec}s`;
    else if (busy) micBtn.innerHTML = '<span class="spin" aria-hidden="true"></span>';
    else micBtn.innerHTML = MIC_ICON;
    micBtn.title = micState === 'recording' ? '再点一下结束，Esc 取消' : busy ? '识别中…' : voice === 'off' ? '语音输入还没开：点一下去 设置 → 语音输入 打开' : '语音输入：点一下开始说，再点一下结束';
    input.placeholder = micState === 'recording' ? '正在听…' : busy ? '识别中…' : PLACEHOLDER;
    clearTimeout(noteTimer);
    if (micState === 'recording') setHint(`正在听 ${m.sec}s / ${m.max}s`, 'recording');
    else if (micState === 'starting') setHint('正在打开麦克风…', 'transcribing');
    else if (busy) setHint('识别中…', 'transcribing');
    else if (m.note) { setHint(m.note, 'note'); noteTimer = setTimeout(() => setHint(), 4000); }
    else setHint();
  }
  window.petPanel.onMic((m) => {
    if (!m) return;
    paintMic(m);
    if (!m.text) return;
    // the recognised words go after what is typed; with 识别后直接发送 they go to her at once
    const cur = input.value.trimEnd();
    input.value = `${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${m.text}`.slice(0, Number(input.maxLength) || 2000);
    fitInput();
    window.petPanel.draft(input.value);
    if (m.autoSend) { sendChat(); return; }
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  });
  micBtn.addEventListener('mousedown', (e) => e.preventDefault()); // the box keeps the focus
  micBtn.addEventListener('click', () => window.petPanel.act('voice'));

  // the box grows with what is typed (up to INPUT_MAX_H) and the window with it
  function fitInput() {
    input.style.height = 'auto';
    const h = Math.min(input.scrollHeight, INPUT_MAX_H);
    input.style.height = `${h}px`;
    input.style.overflowY = input.scrollHeight > INPUT_MAX_H ? 'auto' : 'hidden';
    sendBtn.disabled = !input.value.trim();
  }
  function sendChat() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    fitInput();
    window.petPanel.chat(text);
  }
  input.addEventListener('input', () => {
    fitInput();
    window.petPanel.draft(input.value); // 插个嘴 (its 聊天框草稿 source): her window decides whether it is heard
  });
  input.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a new line; an Enter that confirms an IME composition sends nothing
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendChat();
  });
  $('pp-chat').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
  // 📎: pictures and files are in her window's chat bar; the draft goes along with them
  const handOff = (act) => {
    const text = input.value;
    input.value = '';
    fitInput();
    window.petPanel.act(act, undefined, text);
  };
  // a message she did not send (she was busy) comes back, unless something new was typed meanwhile
  window.petPanel.onRestore((m) => {
    if (!m || !m.text || input.value.trim()) return;
    input.value = m.text;
    fitInput();
  });
  $('pp-chat-attach').addEventListener('click', () => handOff('attach'));

  window.petPanel.onShow((m) => {
    if (!m || !m.payload) return;
    paint(m.payload);
    if (m.fresh) {
      showFoods(false);
      // the pop-in plays again on every opening
      panel.style.animation = 'none';
      void panel.offsetWidth;
      panel.style.animation = '';
      fitInput();
      input.focus({ preventScroll: true }); // typing goes straight into the chat box; Tab reaches the buttons
    }
    lastSize = '';
    report();
  });
  window.petPanel.onClosed(() => { showFoods(false); paintMic({ state: 'idle' }); }); // a recording goes on in her chat bar

  panel.addEventListener('click', (e) => {
    const food = e.target.closest && e.target.closest('[data-food]');
    if (food) { window.petPanel.act('feed', food.dataset.food); return; }
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'feed') { showFoods(); return; }
    showFoods(false);
    window.petPanel.act(act);
  });

  // keyboard: arrows move between the buttons in reading order; Esc closes the foods first, then the panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (e.isComposing || e.keyCode === 229) return; // Esc cancels the IME composition in the chat box first
      e.preventDefault();
      if (micState !== 'idle') { window.petPanel.act('voice-cancel'); return; } // Esc while 🎤 listens throws the recording away
      if (!$('food-menu').classList.contains('hidden')) { showFoods(false); document.querySelector('[data-act="feed"]').focus(); return; }
      window.petPanel.close('esc');
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    if (e.target === input) return; // the arrows move the caret in the chat box
    const items = [...panel.querySelectorAll('button')].filter((b) => !b.disabled && b.offsetParent);
    const i = items.indexOf(document.activeElement);
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const n = items[(i + step + items.length) % items.length];
    if (n) { e.preventDefault(); n.focus(); }
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
