'use strict';

// 她的面板: draws what her window sends (app.js panelPayload) and hands each pressed button back to it (through
// main: pet-panel:act → panel-act). The window is only as big as the card (it reports its size), so it sits
// right beside her. Keyboard: Tab / Shift+Tab move between the buttons, ←→↑↓ too; Enter / Space press; Esc closes.
(() => {
  const $ = (id) => document.getElementById(id);
  const panel = $('pet-panel');
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

  window.petPanel.onShow((m) => {
    if (!m || !m.payload) return;
    paint(m.payload);
    if (m.fresh) {
      showFoods(false);
      // the pop-in plays again on every opening
      panel.style.animation = 'none';
      void panel.offsetWidth;
      panel.style.animation = '';
      panel.focus({ preventScroll: true }); // the keyboard works at once (←→ reach the buttons), with no ring on a tile
    }
    lastSize = '';
    report();
  });
  window.petPanel.onClosed(() => showFoods(false));

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
      e.preventDefault();
      if (!$('food-menu').classList.contains('hidden')) { showFoods(false); document.querySelector('[data-act="feed"]').focus(); return; }
      window.petPanel.close('esc');
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const items = [...panel.querySelectorAll('button')].filter((b) => !b.disabled && b.offsetParent);
    const i = items.indexOf(document.activeElement);
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const n = items[(i + step + items.length) % items.length];
    if (n) { e.preventDefault(); n.focus(); }
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
