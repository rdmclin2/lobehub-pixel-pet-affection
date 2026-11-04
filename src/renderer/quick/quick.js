'use strict';

// 快捷调用面板 page (T-2849): draws the rows main sends (core/quick-panel.js buildItems), filters them as you
// type, moves the highlight with ↑↓ / the pointer, runs a row on ↩ / click, and shows how 检查更新 goes.
// Main owns the window (src/main/quick-panel.js): this page only reports its height and asks to close.

const Q = window.PetQuick;
const $ = (id) => document.getElementById(id);

const ICONS = {
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  quit: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  loading: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  success: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  info2: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
};
const TONE_ICON = { loading: 'loading', success: 'success', info: 'download', warning: 'alert', error: 'alert' };
const ACTION_ICON = { install: 'download', 'open-download': 'download', retry: 'refresh' };
const ico = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

let data = { items: [], feedback: null, hotkey: null, platform: '' };
let rows = []; // what is shown now: items (filtered) with the update status and its follow-up row
let active = -1;
let keyboard = false; // the highlight was moved with the keys: the pointer resting on a row does not take it back

function visibleRows() {
  const q = $('q').value;
  const out = Q.filterItems(data.items, q).map((it) => ({ ...it }));
  const fb = data.feedback;
  const at = out.findIndex((r) => r.id === 'check-update');
  if (fb && at >= 0) {
    out[at] = { ...out[at], busy: fb.tone === 'loading' };
    const extra = [{ type: 'status', fb }];
    if (fb.action) extra.push({ id: fb.action.id, label: fb.action.label, icon: ACTION_ICON[fb.action.id] || 'refresh', action: true });
    out.splice(at + 1, 0, ...extra);
  }
  return out;
}

const navigable = (r) => r && r.id && !r.disabled;

function render() {
  rows = visibleRows();
  const list = $('list');
  list.innerHTML = '';
  if (!rows.some(navigable)) {
    const n = document.createElement('div');
    n.className = 'none';
    n.textContent = `没有匹配“${$('q').value.trim()}”的操作`;
    list.appendChild(n);
  }
  rows.forEach((r, i) => {
    if (r.type === 'separator') {
      const s = document.createElement('div');
      s.className = 'sep';
      s.setAttribute('role', 'separator');
      list.appendChild(s);
      return;
    }
    if (r.type === 'status') {
      const s = document.createElement('div');
      s.className = 'status';
      s.dataset.tone = r.fb.tone;
      s.dataset.status = r.fb.status;
      s.setAttribute('role', 'status');
      s.setAttribute('aria-live', 'polite');
      s.innerHTML = `${ico(TONE_ICON[r.fb.tone] || 'info2', r.fb.tone === 'loading' ? 'spin' : '')}<div><div class="t"></div><div class="d"></div></div>`;
      s.querySelector('.t').textContent = r.fb.title;
      s.querySelector('.d').textContent = r.fb.detail || '';
      list.appendChild(s);
      return;
    }
    const el = document.createElement('div');
    el.className = 'row';
    el.id = `row-${r.id}`;
    el.dataset.id = r.id;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(i === active));
    if (r.disabled) el.setAttribute('aria-disabled', 'true');
    el.innerHTML = `${ico(r.busy ? 'loading' : r.icon, r.busy ? 'spin' : '')}<span class="label"></span><span class="hint"></span>`;
    el.querySelector('.label').textContent = r.label;
    el.querySelector('.hint').textContent = r.busy ? '检查中' : r.hint || r.detail || '';
    el.addEventListener('mousemove', () => { if (keyboard) { keyboard = false; } if (active !== i) setActive(i); });
    el.addEventListener('mouseleave', () => { if (!keyboard) setActive(-1); });
    el.addEventListener('click', () => runRow(i));
    list.appendChild(el);
  });
  syncActive();
  reportSize();
}

function syncActive() {
  [...document.querySelectorAll('.row')].forEach((el) => {
    const on = el.dataset.id === (rows[active] && rows[active].id);
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });
  const r = rows[active];
  if (r && r.id) $('q').setAttribute('aria-activedescendant', `row-${r.id}`);
  else $('q').removeAttribute('aria-activedescendant');
}

function setActive(i) {
  active = i;
  syncActive();
}

let lastH = 0;
function reportSize() {
  requestAnimationFrame(() => {
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h && h !== lastH) { lastH = h; window.quick.size(h); }
  });
}

async function runRow(i) {
  const r = rows[i];
  if (!navigable(r)) return;
  await window.quick.run(r.id);
}

function footer() {
  const f = $('foot');
  const hk = data.hotkey;
  f.textContent = hk && hk.state === 'ok' ? `${hk.label} 唤出 / 关闭 · ↑↓ 选择 · ↩ 执行` : '快捷键被占用，右键她也能打开 · ↑↓ ↩';
  f.title = hk && hk.state === 'ok' ? '' : '⌘⌥P / Ctrl+Alt+P 和备选组合都被其他应用占用了';
}

window.quick.onOpen((p) => {
  data = { items: p.items || [], feedback: p.feedback || null, hotkey: p.hotkey || null, platform: p.platform || '' };
  // light / dark as the pet window shows it (settings.ui.theme, else the OS; tokens follow <html data-theme>)
  if (p.theme === 'light' || p.theme === 'dark') document.documentElement.dataset.theme = p.theme;
  else delete document.documentElement.dataset.theme;
  $('q').value = '';
  $('filter').classList.add('empty');
  active = -1;
  keyboard = false;
  lastH = 0;
  footer();
  render();
  const m = $('menu');
  m.classList.remove('opening');
  void m.offsetWidth;
  m.classList.add('opening');
  $('q').focus();
});

window.quick.onFeedback((fb) => {
  const id = rows[active] && rows[active].id;
  data.feedback = fb;
  render();
  // keep the highlight where it was (or on the follow-up row once there is one to press)
  const want = rows.findIndex((r) => r.id === id);
  const act = rows.findIndex((r) => r.action);
  setActive(keyboard && act >= 0 ? act : want);
});

window.quick.onClosed(() => { $('q').blur(); });

$('q').addEventListener('input', () => {
  $('filter').classList.toggle('empty', !$('q').value);
  render();
  active = $('q').value ? Q.moveActive(rows, -1, 1) : -1;
  syncActive();
});

document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if ($('q').value) { $('q').value = ''; $('q').dispatchEvent(new Event('input')); return; }
    window.quick.close('esc');
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    keyboard = true;
    setActive(Q.moveActive(rows, active, e.key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (active >= 0) runRow(active);
    return;
  }
  // the shortcuts shown on the right work here too (⌘, / ⌘⇧R / ⌘Q)
  const k = { key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey };
  const i = rows.findIndex((r) => r.keys && Q.matchesKeys(r.keys, k, data.platform));
  if (i >= 0) { e.preventDefault(); runRow(i); }
});

// a click on the panel's own padding keeps the typing in the filter
document.addEventListener('mousedown', (e) => { if (e.target !== $('q')) e.preventDefault(); });
