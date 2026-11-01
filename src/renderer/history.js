'use strict';

// ⋯ → 聊天记录: the conversations the owner started, list → detail, inside the shared panel (app.js).
// Main has already filtered them (PetService.history → core/chat-log.js userSessions); this file only
// draws what it is given and never asks for anything else.
(function () {
  let openId = null; // the conversation shown in detail, null for the list
  let seq = 0; // a newer render wins over a slower one still waiting for main
  let lastCtx = null;
  let redrawnFor = null; // the round live() last redrew the conversation for

  const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const attachLine = (a) => (a ? [a.images ? `📷 ${a.images} 张图片` : '', ...(a.files || []).map((f) => `📄 ${f}`)].filter(Boolean).join('  ') : '');

  function reset() {
    openId = null;
  }

  async function render(ctx) {
    lastCtx = ctx;
    const my = ++seq;
    const body = ctx.$('panel-body');
    if (openId) {
      const r = await ctx.api.historyGet(openId);
      if (my !== seq || !ctx.isOpen()) return;
      if (!r.ok) { openId = null; return render(ctx); }
      return renderDetail(ctx, body, r.session);
    }
    const r = await ctx.api.historyList();
    if (my !== seq || !ctx.isOpen()) return;
    renderList(ctx, body, r);
  }

  function renderList(ctx, body, r) {
    ctx.$('panel-title').textContent = '聊天记录';
    ctx.$('panel-sub').textContent = r.sessions.length ? `${r.sessions.length} 段你主动发起的聊天 · 最新的在最上面` : '只显示你主动发起的聊天';
    body.innerHTML = '';
    if (!r.sessions.length) {
      const empty = el('div', 'history-empty');
      empty.append(el('p', 'history-empty-title', '还没有你主动发起的聊天'), el('p', 'adv-note', '点「聊天」和她说句话，这里就会记下来。她自己搭话、问候、被摸或被喂时说的话不算在内。'));
      body.appendChild(empty);
      return;
    }
    const list = el('div', 'history-list');
    for (const s of r.sessions) {
      const b = el('button', 'history-item');
      b.dataset.session = s.id;
      const top = el('span', 'history-meta');
      top.append(el('span', 'history-time', fmt(s.startedAt)), el('span', 'history-who', s.name), el('span', 'history-count', `${s.count} 条`));
      b.append(top, el('span', 'history-preview', s.preview || '（空消息）'));
      b.setAttribute('aria-label', `${fmt(s.startedAt)}，和${s.name}，${s.count} 条：${s.preview}`);
      b.addEventListener('click', () => { openId = s.id; render(ctx); });
      list.appendChild(b);
    }
    body.appendChild(list);
    body.appendChild(el('p', 'adv-note history-foot', '只保存在这台电脑上；放生后会一起清除。'));
  }

  function renderDetail(ctx, body, s) {
    ctx.$('panel-title').textContent = `聊天记录 · ${s.name}`;
    ctx.$('panel-sub').textContent = `${fmt(s.startedAt)} – ${fmt(s.endedAt)} · ${s.count} 条`;
    body.innerHTML = '';
    const back = el('button', 'btn history-back', '← 返回列表');
    back.addEventListener('click', () => { openId = null; render(ctx); });
    body.appendChild(back);
    const thread = el('div', 'history-thread');
    thread.dataset.session = s.id;
    for (const m of s.messages) {
      const row = el('div', `history-msg ${m.role}`);
      row.dataset.role = m.role;
      if (m.turnId) row.dataset.turn = m.turnId;
      const head = el('div', 'history-msg-head', `${m.role === 'user' ? '我' : s.name} · ${fmt(m.at)}`);
      const text = m.status ? (m.status === 'canceled' ? '（这句被打断了，她没有回复）' : '（出错了，她没有回复）') : m.text || '';
      const t = el('div', `history-msg-text${m.status ? ' missing' : ''}`, text);
      row.append(head, t);
      const a = attachLine(m.attachments);
      if (a) row.appendChild(el('div', 'history-msg-attach', a));
      thread.appendChild(row);
    }
    body.appendChild(thread);
    body.scrollTop = 0;
  }

  // 流式回复: her reply to a message shown in the open conversation fills in as it is written (a row marked
  // .streaming under the owner's message of that round); when it ends the conversation is drawn again from
  // 聊天记录, so what stays is exactly what was saved.
  function live({ $, turnId, text, done }) {
    if (!openId || !turnId) return;
    const thread = $('panel-body').querySelector('.history-thread');
    const mine = thread && thread.querySelector(`.history-msg.user[data-turn="${CSS.escape(turnId)}"]`);
    if (done) { if (lastCtx && (mine || redrawnFor === turnId)) render(lastCtx); return; }
    if (!mine) {
      // a round started after this conversation was drawn: draw it again once (main has her message by now)
      if (redrawnFor !== turnId && lastCtx) { redrawnFor = turnId; render(lastCtx); }
      return;
    }
    let row = thread.querySelector(`.history-msg.pet.streaming[data-turn="${CSS.escape(turnId)}"]`);
    if (!row) {
      row = el('div', 'history-msg pet streaming');
      row.dataset.role = 'pet';
      row.dataset.turn = turnId;
      row.append(el('div', 'history-msg-head', '正在输入…'), el('div', 'history-msg-text'));
      mine.after(row);
    }
    row.querySelector('.history-msg-text').textContent = text;
  }

  window.PetHistory = { render, reset, live };
})();
