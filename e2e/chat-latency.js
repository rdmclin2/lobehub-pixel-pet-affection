'use strict';
// 聊天窗口 vs 桌面对话 测速 (docs/admin-chat-latency.md). Real LobeHub, a few tokens: launches the real app with the
// real `lh` login (direct Responses SSE on, `lh connect` off, local abilities off), meets 大肥鱼 (DeepSeek), picks
// one model for her, then sends the same messages through both ways, interleaved round by round:
//   - desktop: the pet window's chat box → bubble (PetService#chat, renderer/app.js onChatDelta)
//   - admin:   设置窗口 → 聊天 (PetService#chatAs, admin-chat-delta → admin/src/console/pages/Chat.tsx)
// Every third round is "cold": the model list is expired first (as after MODELS_TTL_MS), the others "warm".
// Main writes one latency line per turn (PIXELPET_LATENCY=1, core/latency.js); each window measures when the
// reply first shows on screen (first frame with text) and when the streamed bubble is done, on the same clock.
// Usage:  unset ELECTRON_RUN_AS_NODE; xvfb-run -a node e2e/run.js latency [label]   (or: node e2e/chat-latency.js [label])
// Not part of `all`: it talks to the real LobeHub (tokens).
//   LAT_ROUNDS (9), LAT_COLD_EVERY (3; 0 = all warm), LAT_MODEL (a regexp on the model label / id, default
//   "V4\.1 Flash|flash"), LAT_LONG=1 (ask for ~400 字 instead of ~80), LAT_RAW (5: turns sent afterwards straight
//   to the Responses API from node with the same agent, topic and prompt shape — the floor without the app),
//   LAT_LHRUN (0: turns sent through `lh agent run --json`, the fallback way, from node),
//   LAT_SEQ=1 (a screenshot of the chat page every ~250 ms while each of its replies streams → <label>-seq/),
//   LAT_VIDEO=1 (Playwright records every window → <label>-video/, plus <label>-video-marks.json: ms since launch)
// → out/e2e/chat-latency/<label>.json (+ screenshots), and a summary table on stdout.
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'e2e', 'chat-latency');
let label = 'baseline';
const ROUNDS = Number(process.env.LAT_ROUNDS || 9);
const COLD_EVERY = Number(process.env.LAT_COLD_EVERY || 3);
const MODEL_RE = new RegExp(process.env.LAT_MODEL || 'V4\\.1 Flash|flash', 'i');
const SPECIES = process.env.LAT_SPECIES || 'dafeiyu';
const TOPICS = ['早餐吃什么', '下雨天适合做什么', '最喜欢的颜色', '周末的安排', '一本想读的书', '在海边散步', '养一盆植物', '学一门乐器', '深夜的夜宵', '冬天的第一场雪', '一部老电影', '收拾房间'];
const LONG = process.env.LAT_LONG === '1'; // long replies (~400 字): what the chat page's smoothed Markdown does with them
const FRESH_EVERY = Number(process.env.LAT_FRESH_EVERY || 0); // every Nth round the chat page's turn opens a fresh topic (as after 4 h)
const LHRUN = Number(process.env.LAT_LHRUN || 0); // turns sent through `lh agent run --json` (the fallback way) from node
const SEQ = process.env.LAT_SEQ === '1';
const VIDEO = process.env.LAT_VIDEO === '1';
const RAW = Number(process.env.LAT_RAW ?? 5); // turns sent straight to the Responses API from node (no Electron, no UI)
const message = (i) => `第${i + 1}轮：请用大约 ${LONG ? 400 : 80} 个字，和我聊聊「${TOPICS[i % TOPICS.length]}」。`;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => process.stdout.write(`${s}\n`);

// In each window: arm(kind) before a send; a frame loop notes the first frame whose streaming bubble has text,
// how many characters are on screen each frame, and when the streamed bubble is gone (the reply is final).
const PROBE = () => {
  const L = (window.__lat = { turns: [], cur: null });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (L.cur && !L.cur.doneAt) { L.cur.longtasks += 1; L.cur.longtaskMs += e.duration; } }).observe({ type: 'longtask', buffered: false });
  } catch { /* older engines */ }
  const admin = location.href.includes('admin-ui');
  const streamingText = () => {
    if (admin) {
      const el = document.querySelector('[data-streaming]');
      if (!el) return null;
      const md = el.querySelector('.lobe-markdown, [class*="markdown"]');
      return md ? md.innerText.trim() : '';
    }
    const b = document.getElementById('bubble');
    return b && b.classList.contains('streaming') ? (b.textContent || '').trim() : null;
  };
  const finalText = () => {
    if (admin) {
      const all = [...document.querySelectorAll('[data-chat-page] [data-role="assistant"]')];
      const el = all[all.length - 1];
      if (!el) return '';
      return ((el.querySelector('.lobe-markdown, [class*="markdown"]') || el).innerText || '').trim();
    }
    return (document.getElementById('bubble').textContent || '').trim();
  };
  window.__latArm = (kind) => {
    const T = { kind, sendAt: Date.now(), firstPaint: null, sawStream: false, samples: [], doneAt: null, finalChars: null, lastStreamChars: 0, frames: 0, longtasks: 0, longtaskMs: 0 };
    L.cur = T;
    L.turns.push(T);
    const tick = () => {
      if (T.doneAt) return;
      T.frames += 1;
      const t = streamingText();
      if (t !== null) {
        T.sawStream = true;
        const n = [...t].length;
        if (n && !T.firstPaint) T.firstPaint = Date.now();
        if (n !== T.lastStreamChars && T.samples.length < 4000) T.samples.push([Date.now() - T.sendAt, n]);
        if (n) T.lastStreamChars = n;
      } else if (T.sawStream && (admin || !document.body.classList.contains('busy'))) {
        T.doneAt = Date.now();
        T.finalChars = [...finalText()].length;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return T.sendAt;
  };
};

async function openAdminWindow(app, page, route) {
  await page.evaluate((r) => window.pet.openAdmin(r), route);
  let admin = null;
  for (let i = 0; i < 300 && !admin; i++) {
    admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
    if (!admin) await sleep(100);
  }
  if (!admin) throw new Error('the settings window did not open');
  await admin.waitForSelector(`[data-path="/${route}"]`, { timeout: 15000 });
  return admin;
}

async function until(p, fn, arg, ms, what) {
  const t0 = Date.now();
  for (;;) {
    if (await p.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const q = (xs, p) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(v[lo] + (v[hi] - v[lo]) * (i - lo));
};

async function main(name = 'baseline') {
  label = name;
  delete process.env.ELECTRON_RUN_AS_NODE; // Electron would start as plain node and Playwright could not attach
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-latency-'));
  const latFile = path.join(data, 'latency.jsonl');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, proactive: { enabled: false } }));
  const env = { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_CATALOG_PREINSTALLED: path.join(ROOT, 'catalog'), PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1', PIXELPET_DIRECT: '1', PIXELPET_LATENCY: '1', PIXELPET_LATENCY_FILE: latFile };
  for (const k of ['LOBEHUB_OPERATION_ID', 'LOBEHUB_TOPIC_ID', 'LOBEHUB_AGENT_ID', 'LOBEHUB_ASSISTANT_MESSAGE_ID']) delete env[k];
  const extraArgs = (process.env.LAT_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
  const launchedAt = Date.now();
  const videoMarks = [];
  const vmark = (what) => { if (VIDEO) videoMarks.push({ ms: Date.now() - launchedAt, what }); };
  const app = await _electron.launch({ args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs], cwd: ROOT, env, ...(VIDEO ? { recordVideo: { dir: path.join(OUT, `${name}-video`), size: { width: 1280, height: 800 } } } : {}) });
  await app.context().addInitScript(PROBE);
  let stdout = '';
  app.process().stdout.on('data', (d) => { stdout += d; });
  const page = await app.firstWindow();
  page.on('dialog', (d) => d.accept());
  const report = { label, startedAt: new Date().toISOString(), rounds: ROUNDS, coldEvery: COLD_EVERY, species: SPECIES, model: null, chromeArgs: extraArgs, turns: [], summary: {} };
  let agentId = null;
  let ws = null;
  try {
    await page.waitForSelector('.char-card', { timeout: 30000 });
    await page.click(`.char-card[data-species="${SPECIES}"]`);
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt'); // never bind a real computer in tests
    await page.click('#hatch-btn');
    const where = await Promise.race([
      page.waitForSelector('#space-box:not(.hidden)', { timeout: 120000 }).then(() => 'asked'),
      page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 }).then(() => 'not asked'),
    ]);
    if (where === 'asked') await page.click('#space-go');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 150000 }).catch(() => {});
    const pet = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
    agentId = pet.characters[SPECIES].agentId;
    ws = pet.space && pet.space.workspaceId ? pet.space.workspaceId : null;
    say(`met ${SPECIES}: agent ${agentId}`);

    const admin = await openAdminWindow(app, page, `chat/${SPECIES}`);
    vmark('admin window open (its own video starts about here)');
    await admin.setViewportSize({ width: 1080, height: 720 }).catch(() => {});
    await until(admin, () => !!document.querySelector('[data-chat-page] [data-chat-textarea]'), null, 30000, 'chat page');
    await until(admin, (s) => window.petAdmin.state().then((st) => !!st.roster.find((c) => (c.base || c.id) === s && c.model)?.model?.loaded), SPECIES, 60000, 'model list');
    const m = (await admin.evaluate(() => window.petAdmin.state())).roster.find((c) => (c.base || c.id) === SPECIES && c.model).model;
    const picked = m.options.find((o) => MODEL_RE.test(o.label)) || m.options.find((o) => MODEL_RE.test(o.id)) || m.options.find((o) => o.key === m.current) || m.options[0];
    if (picked.key !== m.current) {
      await admin.click('[data-model-select]');
      await until(admin, () => document.querySelectorAll('[role="option"] [data-model-option]').length > 0, null, 10000, 'options');
      await admin.click(`[role="option"] [data-model-option="${picked.key}"]`);
      await until(admin, ([s, k]) => window.petAdmin.state().then((st) => st.roster.find((c) => (c.base || c.id) === s && c.model).model.current === k), [SPECIES, picked.key], 10000, 'picked');
    }
    report.model = { key: picked.key, label: picked.label, options: m.options.map((o) => o.label) };
    say(`model: ${picked.label} (${picked.key})`);
    await sleep(3000); // let the background _applyModel finish before the first measured turn

    // the pet window opened before the init script was added: probe it by hand (the settings window got it)
    for (const p of [page, admin]) if (!(await p.evaluate(() => typeof window.__latArm === 'function'))) await p.evaluate(PROBE);
    const lines = () => (fs.existsSync(latFile) ? fs.readFileSync(latFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    // the desktop chat box is in her panel (T-6162): open it, type, arm the probe, Enter
    const sendDesktop = async (text) => {
      const pp = await require('./pet-panel').openPetPanel(page);
      await pp.fill('#pp-chat-input', text);
      await page.evaluate(() => window.__latArm('desktop'));
      await pp.press('#pp-chat-input', 'Enter');
      return page;
    };
    const sendAdmin = async (text) => {
      await admin.click('[data-chat-textarea]');
      await admin.fill('[data-chat-textarea]', text);
      await admin.evaluate(() => window.__latArm('admin'));
      await admin.keyboard.press('Enter');
      return admin;
    };
    let shots = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const cond = COLD_EVERY > 0 && i % COLD_EVERY === 0 ? 'cold' : 'warm';
      const order = i % 2 ? ['admin', 'desktop'] : ['desktop', 'admin'];
      for (const kind of order) {
        if (cond === 'cold') await page.evaluate(() => window.pet.debugExpireModels());
        // 4 小时换话题: her topic counts as opened long ago, so this chat-page turn rolls it (recentRounds carried over)
        const fresh = kind === 'admin' && FRESH_EVERY > 0 && i % FRESH_EVERY === FRESH_EVERY - 1;
        if (fresh) {
          const tid = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8')).characters[SPECIES].topicId;
          await page.evaluate((id) => window.pet.debugSet({ topicMeta: { id, startedAt: 1 } }), tid);
        }
        const before = lines().length;
        const text = message(i);
        const p = kind === 'admin' ? await sendAdmin(text) : await sendDesktop(text);
        let midShot = shots < 2;
        const t0 = Date.now();
        vmark(`round ${i + 1} ${kind} ${cond}: sent`);
        const seqDir = path.join(OUT, `${label}-seq`);
        if (SEQ && kind === 'admin') fs.mkdirSync(seqDir, { recursive: true });
        let lastSeq = 0;
        let seqChars = -1;
        for (;;) {
          const cur = await p.evaluate(() => { const c = window.__lat.cur; return { doneAt: c.doneAt, chars: c.lastStreamChars }; });
          if (SEQ && kind === 'admin' && !cur.doneAt && Date.now() - lastSeq >= 250 && cur.chars !== seqChars) {
            lastSeq = Date.now();
            seqChars = cur.chars;
            const ms = Date.now() - t0;
            await p.screenshot({ path: path.join(seqDir, `r${i + 1}-${String(ms).padStart(5, '0')}ms-${cur.chars}chars.png`) });
            vmark(`round ${i + 1} admin: ${cur.chars} chars on screen at ${ms} ms`);
          }
          if (midShot && cur.chars > 20) {
            await p.screenshot({ path: path.join(OUT, `${label}-${kind}-streaming.png`) });
            midShot = false;
            shots += 1;
          }
          if (cur.doneAt) { vmark(`round ${i + 1} ${kind}: reply final`); break; }
          if (Date.now() - t0 > 180000) throw new Error(`${kind} round ${i + 1}: no reply within 180 s`);
          await sleep(100);
        }
        const r = await p.evaluate(() => window.__lat.cur);
        let main = null;
        for (let k = 0; k < 50 && !main; k++) {
          main = lines().slice(before).find((x) => x.kind === kind) || null;
          if (!main) await sleep(100);
        }
        const mk = (main && main.marks) || {};
        const at = (name) => (main && typeof mk[name] === 'number' ? main.t0 + mk[name] : null);
        const sub = (a, b) => (a !== null && b !== null ? a - b : null);
        const row = {
          round: i + 1, kind, cond: fresh ? 'fresh' : cond, text, topicFresh: main && main.topicFresh, recentMsgs: main && main.recentMsgs,
          via: main && main.via, fallbackReason: main && main.fallbackReason, modelsCached: main && main.modelsCached, waitedReady: !!(main && main.waitedReady),
          promptChars: main && main.promptChars, bodyChars: main && main.bodyChars, replyChars: main && main.replyChars, deltas: main && main.deltas, ipcBytes: main && main.ipcBytes,
          // the steps, ms
          ipcIn: sub(main && main.t0, r.sendAt), // click → main has the message
          prep: sub(at('reqSent'), main && main.t0), // main: everything before the request (models, persona, model, prompt, token)
          models: mk.models ?? null,
          sendToReq: sub(at('reqSent'), r.sendAt),
          reqToHeaders: sub(at('headers'), at('reqSent')),
          reqToFirstText: sub(at('firstText') ?? at('firstDelta'), at('reqSent')),
          firstTextToShown: sub(at('firstShown'), at('firstText') ?? at('firstDelta')),
          shownToPaint: sub(r.firstPaint, at('firstShown')), // main sent the first piece → the window drew it
          ttft: sub(r.firstPaint, r.sendAt), // what the owner waits for: click → first words on screen
          streamEnd: sub(at('runEnd'), r.sendAt), // the reply is fully in main
          total: sub(r.doneAt, r.sendAt), // click → the final reply on screen
          endToDone: sub(r.doneAt, at('runEnd')),
          // the whole streamed text on screen (the chat page's Markdown smooths it in; the bubble shows it at once)
          fullShown: (() => { let t = null; for (const [ts, c] of r.samples) if (c >= r.lastStreamChars && t === null) t = ts; return t; })(),
          revealLag: (() => { const ls = at('lastShown'); if (ls === null) return null; let t = null; for (const [ts, c] of r.samples) if (c >= r.lastStreamChars && t === null) t = ts; return t === null ? null : r.sendAt + t - ls; })(),
          shownAtStreamEnd: (() => { const e = sub(at('runEnd'), r.sendAt); if (e === null) return null; let n = 0; for (const [t, c] of r.samples) if (t <= e) n = c; return n; })(),
          lastStreamChars: r.lastStreamChars, finalChars: r.finalChars, frames: r.frames, longtasks: r.longtasks, longtaskMs: Math.round(r.longtaskMs),
          marks: mk, samples: r.samples,
        };
        row.fps = row.total ? Math.round((r.frames / row.total) * 1000) : null;
        report.turns.push(row);
        say(`#${row.round} ${kind.padEnd(7)} ${cond} via=${row.via} prompt=${row.promptChars} ipcIn=${row.ipcIn} prep=${row.prep} req→1st=${row.reqToFirstText} shown→paint=${row.shownToPaint} TTFT=${row.ttft} fullShown=${row.fullShown} revealLag=${row.revealLag} streamEnd=${row.streamEnd} total=${row.total} reply=${row.replyChars} shown@end=${row.shownAtStreamEnd} deltas=${row.deltas} ipcKB=${row.ipcBytes ? (row.ipcBytes / 1024).toFixed(1) : null} fps=${row.fps}`);
        await sleep(1500);
      }
    }
    // the floor: the same agent, topic and prompt shape, straight from node (ResponsesClient, no Electron / IPC / UI)
    if (RAW > 0) {
      const { ResponsesClient, createSseParser } = require('../src/core/responses-client');
      // every SSE event of the raw turn, with its time: what the server sends after the last piece of text
      let events = [];
      let evT0 = 0;
      const teeFetch = async (url, opts) => {
        const res = await fetch(url, opts);
        if (!res.body) return res;
        const [a, b] = res.body.tee();
        const parser = createSseParser((type, d) => events.push([Date.now() - evT0, type, typeof d.delta === 'string' ? [...d.delta].length : undefined]));
        (async () => { for await (const chunk of b) parser.push(chunk); parser.end(); })().catch(() => {});
        return new Response(a, { status: res.status, headers: res.headers });
      };
      const persona = require('../src/core/persona');
      const settingsLib = require('../src/core/settings');
      const { createTrace } = require('../src/core/latency');
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
      const c = saved.characters[SPECIES];
      const settings = settingsLib.normalizeSettings(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')));
      const client = new ResponsesClient({ lh: { workspaceId: ws, whoami: async () => null, pinnedWorkspace: async () => null }, env: { ...process.env, LOBEHUB_WORKSPACE_ID: '' }, fetchImpl: teeFetch });
      for (let i = 0; i < RAW; i++) {
        let line = null;
        const trace = createTrace('raw', { env: { PIXELPET_LATENCY: '1' }, write: (l) => { line = JSON.parse(l); } });
        const pieces = [];
        events = [];
        evT0 = trace.t0;
        const prompt = persona.buildChatPrompt(message(ROUNDS + i), c, Date.now(), { local: false, settings });
        trace.set('promptChars', prompt.length);
        const res = await client.run({ agentId: c.agentId, topicId: c.topicId, prompt, onDelta: (chunk) => pieces.push([Date.now() - trace.t0, [...chunk].length]), trace });
        trace.set('replyChars', res.text.length);
        trace.end({ ok: true });
        const mk = line.marks;
        const row = { round: ROUNDS + i + 1, kind: 'raw', cond: 'warm', via: 'direct', promptChars: line.promptChars, replyChars: line.replyChars, deltas: pieces.length, prep: mk.reqSent, reqToHeaders: mk.headers - mk.reqSent, reqToFirstText: mk.firstText - mk.reqSent, ttft: mk.firstText, streamEnd: mk.end, total: mk.end, pieces, marks: mk, events: events.slice() };
        // consecutive events of one type folded: [first ms, last ms, type, count, chars]
        const folded = [];
        for (const [t, type, n] of events) { const f = folded[folded.length - 1]; if (f && f[2] === type) { f[1] = t; f[3] += 1; f[4] += n || 0; } else folded.push([t, t, type, 1, n || 0]); }
        row.eventsFolded = folded;
        say(`   events: ${folded.map(([a, b, type, n, ch]) => `${a}${b !== a ? `-${b}` : ''}ms ${type}${n > 1 ? `×${n}` : ''}${ch ? `(${ch}字)` : ''}`).join(' | ')}`);
        report.turns.push(row);
        say(`#${row.round} raw     warm via=direct prompt=${row.promptChars} prep=${row.prep} req→hdr=${row.reqToHeaders} req→1st=${row.reqToFirstText} TTFT(no UI)=${row.ttft} end=${row.total} reply=${row.replyChars} pieces=${pieces.map((x) => `${x[0]}ms:${x[1]}`).join(',')}`);
        await sleep(1500);
      }
    }
    // the fallback way (_runTurn when the direct one is down or failed): `lh agent run --json`, same agent / topic
    if (LHRUN > 0) {
      const { LhClient } = require('../src/core/lh-client');
      const persona = require('../src/core/persona');
      const settingsLib = require('../src/core/settings');
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
      const c = saved.characters[SPECIES];
      const settings = settingsLib.normalizeSettings(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')));
      const e = { ...process.env, LOBEHUB_JWT: '' };
      for (const k of ['LOBEHUB_WORKSPACE_ID', 'LOBEHUB_TOPIC_ID', 'LOBEHUB_OPERATION_ID', 'LOBEHUB_AGENT_ID']) delete e[k];
      if (ws) e.LOBEHUB_WORKSPACE_ID = ws;
      const lh = new LhClient({ bin: 'lh', env: e });
      lh.setWorkspace(ws);
      for (let i = 0; i < LHRUN; i++) {
        const t0 = Date.now();
        let first = null;
        const prompt = persona.buildChatPrompt(message(ROUNDS + RAW + i), c, Date.now(), { local: false, settings });
        const res = await lh.run({ agentId: c.agentId, topicId: c.topicId, prompt, onDelta: () => { if (first === null) first = Date.now() - t0; } });
        const total = Date.now() - t0;
        const row = { round: ROUNDS + RAW + i + 1, kind: 'lhrun', cond: 'warm', via: 'lh-run', promptChars: prompt.length, replyChars: res.text.length, ttft: first, total, streamEnd: total, marks: { firstText: first, end: total } };
        report.turns.push(row);
        say(`#${row.round} lhrun   warm via=lh-run prompt=${row.promptChars} first text=${first} total=${total} reply=${row.replyChars}`);
        await sleep(1500);
      }
    }
    await admin.screenshot({ path: path.join(OUT, `${label}-admin-final.png`) });
    await page.screenshot({ path: path.join(OUT, `${label}-desktop-final.png`) });

    const keys = ['ipcIn', 'prep', 'models', 'sendToReq', 'reqToHeaders', 'reqToFirstText', 'firstTextToShown', 'shownToPaint', 'ttft', 'streamEnd', 'endToDone', 'fullShown', 'revealLag', 'total', 'promptChars', 'replyChars', 'shownAtStreamEnd', 'deltas', 'ipcBytes', 'longtaskMs', 'fps'];
    for (const kind of ['desktop', 'admin', 'raw', 'lhrun']) {
      for (const cond of ['cold', 'warm', 'fresh', 'all']) {
        const rows = report.turns.filter((t) => t.kind === kind && (cond === 'all' || t.cond === cond));
        if (!rows.length) continue;
        const s = { n: rows.length, via: [...new Set(rows.map((r) => r.via))] };
        for (const k of keys) s[k] = { p50: q(rows.map((r) => r[k]), 0.5), p90: q(rows.map((r) => r[k]), 0.9) };
        report.summary[`${kind}/${cond}`] = s;
      }
    }
    say('\nsummary (ms; p50 / p90):');
    say(['path/cond', 'n', 'via', ...keys].join('\t'));
    for (const [k, s] of Object.entries(report.summary)) say([k, s.n, s.via.join('+'), ...keys.map((x) => `${s[x].p50}/${s[x].p90}`)].join('\t'));
  } finally {
    report.mainStdoutLatencyLines = stdout.split('\n').filter((l) => l.startsWith('[latency]')).length;
    fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(report, null, 2));
    if (VIDEO) fs.writeFileSync(path.join(OUT, `${label}-video-marks.json`), JSON.stringify(videoMarks, null, 2));
    if (fs.existsSync(latFile)) fs.copyFileSync(latFile, path.join(OUT, `${label}-latency.jsonl`));
    say(`→ ${path.relative(ROOT, path.join(OUT, `${label}.json`))}`);
    await app.close().catch(() => {});
    if (agentId) {
      const e = { ...process.env };
      for (const k of ['LOBEHUB_WORKSPACE_ID', 'LOBEHUB_TOPIC_ID', 'LOBEHUB_OPERATION_ID', 'LOBEHUB_AGENT_ID', 'LOBEHUB_JWT']) delete e[k];
      if (ws) e.LOBEHUB_WORKSPACE_ID = ws;
      try { execFileSync('lh', ['agent', 'delete', agentId, '--yes'], { stdio: 'ignore', timeout: 60000, env: e }); say(`(deleted the agent ${agentId})`); } catch (err) { say(`(could not delete the agent ${agentId}: ${err.message})`); }
    }
  }
}

module.exports = { run: main };
if (require.main === module) main(process.argv[2] || 'baseline').catch((e) => { console.error(e); process.exit(1); });
