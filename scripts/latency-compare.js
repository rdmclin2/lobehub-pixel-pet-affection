'use strict';
// 优化前后对比 (docs/admin-chat-latency.md §7): two e2e/chat-latency.js runs (before / after) side by side, per way
// (desktop / admin / raw) and state (cold / warm / all): n, p50, p90, min–max and the change of the p50 / p90.
// Usage: node scripts/latency-compare.js <before.json> <after.json> [metric …]   (default metrics: ttft total prep)
const fs = require('node:fs');

const q = (xs, p) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(v[lo] + (v[hi] - v[lo]) * (i - lo));
};
const NAMES = { ttft: 'TTFT 点击→首字上屏', total: '总耗时 点击→最终回复上屏', prep: 'main 准备（到请求发出）', revealLag: '最后一段→全文上屏', fullShown: '点击→全文上屏', reqToFirstText: '请求→首个文字（服务端）', replyChars: '回复字数' };
const UNIT = { replyChars: '字', promptChars: '字', deltas: '次' };
const [beforeFile, afterFile, ...rest] = process.argv.slice(2);
const metrics = rest.length ? rest : ['ttft', 'total', 'prep'];
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const before = load(beforeFile);
const after = load(afterFile);
const pick = (r, kind, cond) => r.turns.filter((t) => t.kind === kind && (cond === '全部' || t.cond === cond));
const stat = (ts, m) => {
  const xs = ts.map((t) => t[m]).filter((x) => typeof x === 'number');
  return { n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null };
};
const pct = (a, b, u = 'ms') => (a && b !== null ? `${b - a > 0 ? '+' : ''}${b - a} ${u}（${(((b - a) / a) * 100).toFixed(0)}%）` : '—');
for (const m of metrics) {
  const u = UNIT[m] || 'ms';
  console.log(`\n#### ${NAMES[m] || m}（${u}）\n`);
  console.log('| 链路 · 状态 | 优化前 n | 优化前 p50 / p90 | 优化前 min–max | 优化后 n | 优化后 p50 / p90 | 优化后 min–max | p50 变化 | p90 变化 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const kind of ['admin', 'desktop', 'raw']) {
    for (const cond of ['cold', 'warm', 'fresh', '全部']) {
      const b = stat(pick(before, kind, cond), m);
      const a = stat(pick(after, kind, cond), m);
      if (!b.n && !a.n) continue;
      const label = `${{ admin: '聊天窗口', desktop: '桌面', raw: 'raw（node 直连）' }[kind]} · ${{ cold: '冷', warm: '热', fresh: '新话题', 全部: '全部' }[cond]}`;
      console.log(`| ${label} | ${b.n} | ${b.p50} / ${b.p90} | ${b.min}–${b.max} | ${a.n} | ${a.p50} / ${a.p90} | ${a.min}–${a.max} | ${pct(b.p50, a.p50, u)} | ${pct(b.p90, a.p90, u)} |`);
    }
  }
}
