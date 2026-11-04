'use strict';
// 测速报告 (docs/admin-chat-latency.md): the tables of one or more e2e/chat-latency.js runs, as Markdown.
// Usage: node scripts/latency-report.js out/e2e/chat-latency/baseline.json [more.json …]
const fs = require('node:fs');

const q = (xs, p) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(v[lo] + (v[hi] - v[lo]) * (i - lo));
};
const COLS = [
  ['ttft', 'TTFT 点击→首字上屏'],
  ['total', '总耗时 点击→最终回复上屏'],
  ['ipcIn', '点击→main 收到'],
  ['prep', 'main 准备（到请求发出）'],
  ['models', '其中 refreshModels'],
  ['reqToHeaders', '请求→响应头'],
  ['reqToFirstText', '请求→首个文字 delta'],
  ['shownToPaint', 'main 发出首段→窗口首帧'],
  ['revealLag', '最后一段→全文上屏'],
  ['tail', '最后一段文字→流结束'],
  ['promptChars', 'prompt 字符'],
  ['replyChars', '回复字符'],
  ['deltas', '推给窗口的次数'],
  ['ipcBytes', '推给窗口的字节'],
];
const rows = [];
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const t of r.turns) {
    const ls = t.marks && typeof t.marks.lastShown === 'number' ? t.marks.lastShown : t.marks && t.marks.firstText;
    const end = t.marks && (t.marks.runEnd ?? t.marks.end);
    const firstText = t.marks && (t.marks.firstText ?? t.marks.firstDelta);
    // raw turns have no lastShown: the last piece's time
    const last = t.kind === 'raw' && t.pieces && t.pieces.length ? t.pieces[t.pieces.length - 1][0] : ls;
    rows.push({ ...t, run: r.label, tail: typeof end === 'number' && typeof last === 'number' ? end - last : typeof end === 'number' && typeof firstText === 'number' ? end - firstText : null });
  }
}
const groups = new Map();
for (const t of rows) {
  for (const k of [`${t.run} · ${t.kind} · ${t.cond}`, `${t.run} · ${t.kind} · 全部`]) {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
}
const fmt = (a, b) => (a === null ? '—' : `${a} / ${b}`);
console.log(`| 组（run · 链路 · 状态） | n | via | ${COLS.map((c) => c[1]).join(' | ')} |`);
console.log(`|---|---|---|${COLS.map(() => '---').join('|')}|`);
for (const [k, ts] of groups) {
  console.log(`| ${k} | ${ts.length} | ${[...new Set(ts.map((t) => t.via))].join('+')} | ${COLS.map(([c]) => fmt(q(ts.map((t) => t[c]), 0.5), q(ts.map((t) => t[c]), 0.9))).join(' | ')} |`);
}
