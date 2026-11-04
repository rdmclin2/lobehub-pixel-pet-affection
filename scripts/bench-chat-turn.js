'use strict';
// 测速 (docs/admin-chat-latency.md §4): the synchronous work in main before a turn's request goes out, on a full
// 聊天记录 (MAX_MESSAGES = 3000). Runs the same calls as PetService#chatAs / #chat and main's admin-chat-changed
// round trip (chatCharacters), on a real ChatLog file in a temp folder. No network.
// Usage: node scripts/bench-chat-turn.js [messages=3000] [reps=50]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chatLog = require('../src/core/chat-log');
const adminChat = require('../src/core/admin-chat');

const N = Number(process.argv[2] || chatLog.MAX_MESSAGES);
const REPS = Number(process.argv[3] || 50);
const SPECIES = ['claude', 'dafeiyu', 'gemini', 'gpt', 'grok'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-bench-'));
const now = Date.now();
const line = '今天天气不错，我们去海边散步吧，顺便买点好吃的回来，晚上一起看一部老电影怎么样？';
const messages = [];
for (let i = 0; i < N; i++) {
  const sp = SPECIES[Math.floor(i / 2) % SPECIES.length];
  const at = now - (N - i) * 60000; // one a minute: the last 4 hours hold 240 of them
  messages.push({ id: `m${i + 1}`, at, speciesId: sp, origin: 'user', kind: 'chat', via: i % 4 < 2 ? 'console' : undefined, role: i % 2 ? 'pet' : 'user', turnId: `t${Math.floor(i / 2)}`, text: line.repeat(1 + (i % 3)) });
}
fs.writeFileSync(path.join(dir, 'chat-log.json'), JSON.stringify({ schema: 1, seq: N, messages }));
const log = new chatLog.ChatLog(dir);
log.list(); // the first read (cached afterwards)

const time = (fn) => {
  const xs = [];
  for (let i = 0; i < REPS; i++) {
    const t = process.hrtime.bigint();
    fn(i);
    xs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  xs.sort((a, b) => a - b);
  return { p50: +xs[Math.floor(REPS / 2)].toFixed(2), p90: +xs[Math.floor(REPS * 0.9)].toFixed(2) };
};

const all = log.list();
const conv = adminChat.conversationOf(all, 'dafeiyu');
const res = {
  messages: N,
  fileKB: Math.round(fs.statSync(path.join(dir, 'chat-log.json')).size / 1024),
  convMsgs: conv.length,
  'conversationOf (chatAs, once per turn)': time(() => adminChat.conversationOf(log.list(), 'dafeiyu')),
  'log.append (sync write of the whole file; chat: 2× per turn, chatAs: 2×)': time((i) => log.append({ speciesId: 'dafeiyu', origin: 'user', kind: 'chat', role: 'user', turnId: `bench${i}`, text: line }, now + i)),
  'chatCharacters (every admin-chat-changed: 2× per chat-page turn, 1× per desktop turn)': time(() => {
    const a = log.list();
    for (const sp of SPECIES) adminChat.conversationOf(a, sp);
  }),
  'recentRounds (fresh topic only)': time(() => adminChat.recentRounds(conv, now)),
  'pickRecall (a question about the past only)': time(() => adminChat.pickRecall(conv.slice(0, -240), '还记得上次我们聊过的海边散步吗')),
  'recentRounds chars carried': adminChat.transcript(adminChat.recentRounds(conv, now), '大肥鱼').length,
};
console.log(JSON.stringify(res, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
