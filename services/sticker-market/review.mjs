#!/usr/bin/env node
// 表情包商店 · 审核 (先审后发): what is waiting, and the maintainer's decision on one.
//
//   node services/sticker-market/review.mjs list
//   node services/sticker-market/review.mjs approve <id>
//   node services/sticker-market/review.mjs reject <id> "<reason the owner sees>"
//
// Env: STICKER_MARKET_URL (http://127.0.0.1:8790), STICKER_MARKET_ADMIN_TOKEN (the service's).

const base = (process.env.STICKER_MARKET_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const token = process.env.STICKER_MARKET_ADMIN_TOKEN;
if (!token) {
  console.error('STICKER_MARKET_ADMIN_TOKEN is not set');
  process.exit(1);
}
const [cmd, id, reason] = process.argv.slice(2);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
let res;
if (cmd === 'list') res = await fetch(`${base}/v1/admin/pending`, { headers });
else if (cmd === 'approve' || cmd === 'reject') res = await fetch(`${base}/v1/admin/sticker-sets/${id}/review`, { method: 'POST', headers, body: JSON.stringify({ decision: cmd, reason }) });
else {
  console.error('usage: review.mjs list | approve <id> | reject <id> "<reason>"');
  process.exit(1);
}
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
process.exit(res.ok ? 0 : 1);
