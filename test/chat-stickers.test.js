'use strict';

// 聊天内发送表情包 (docs/stickers-design.md §3): a 表情包 picked in a chat panel is one message of 聊天记录
// (core/chat-log.js `sticker` field) — written, read back after a restart, shown by the chat page and the
// history; old records without the field read as before; the agent gets its meaning in words; a sticker in
// her reply is kept too; only a set she holds can be sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const chatLog = require('../src/core/chat-log');
const AC = require('../src/core/admin-chat');
const S = require('../src/core/stickers');
const { getSpecies } = require('../src/core/species');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-stickers-'));
const SHA = 'a'.repeat(64);

const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, [r, g, b] = [255, 0, 0]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- chat-log: the new field -----------------------------------------------------------------------------
test('chat-log: a sticker message (text "") is written with its sticker and read back from a fresh ChatLog (a restart)', () => {
  const dir = tmp();
  const log = new chatLog.ChatLog(dir);
  const sticker = { ref: `blob:${SHA}.png`, set: 'mine-dafeiyu', id: 'u1', label: '超开心' };
  log.append({ speciesId: 'dafeiyu', role: 'user', origin: 'user', kind: 'chat', turnId: 't1', text: '', sticker }, 1000);
  log.append({ speciesId: 'dafeiyu', role: 'pet', origin: 'user', kind: 'chat', turnId: 't1', text: '哈哈你也太开心了', sticker: { ref: 'builtin:dafeiyu/rice.webp', set: 'builtin:dafeiyu', id: 'rice', label: '干饭' } }, 2000);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'chat-log.json'), 'utf8'));
  assert.deepEqual(raw.messages[0].sticker, sticker, 'kept on disk as given');
  const again = new chatLog.ChatLog(dir).list();
  assert.deepEqual(again.map((m) => [m.role, m.text, m.sticker && m.sticker.ref]), [['user', '', `blob:${SHA}.png`], ['pet', '哈哈你也太开心了', 'builtin:dafeiyu/rice.webp']]);
  // the history keeps the round (the owner started it) and the preview names the sticker
  const s = chatLog.userSessions(again).sessions;
  assert.equal(s.length, 1);
  assert.equal(s[0].preview, '［表情包：超开心］');
  assert.deepEqual(s[0].messages.map((m) => m.sticker.label), ['超开心', '干饭']);
});

test('chat-log: old records (no sticker) read exactly as before; a malformed sticker is dropped, its message kept', () => {
  const dir = tmp();
  // schema 0 (a bare array) and schema 1 records written before stickers existed
  const old = [
    { id: 'm1', at: 1000, speciesId: 'claude', role: 'user', origin: 'user', kind: 'chat', turnId: 't1', text: '在吗' },
    { id: 'm2', at: 2000, speciesId: 'claude', role: 'pet', origin: 'user', kind: 'chat', turnId: 't1', text: '在呀' },
    { id: 'm3', at: 3000, speciesId: 'claude', role: 'user', origin: 'user', kind: 'chat', turnId: 't2', text: '', attachments: { images: 1 } },
  ];
  fs.writeFileSync(path.join(dir, 'chat-log.json'), JSON.stringify(old));
  const list = new chatLog.ChatLog(dir).list();
  assert.deepEqual(list, old, 'nothing added to an old record');
  const norm = list.map(chatLog.normalize);
  assert.ok(norm.every((m) => !('sticker' in m)));
  assert.equal(chatLog.userSessions(list).sessions[0].preview, '在吗');
  // hand-edited / forged stickers: not a loadable ref → the field goes, the message stays
  for (const bad of [{ ref: 'file:///etc/passwd', label: 'x' }, { ref: '../../x.png' }, { ref: `blob:${SHA}.svg` }, 'rice', 42, null]) {
    const m = chatLog.normalize({ id: 'x', at: 1, role: 'user', origin: 'user', turnId: 't', text: 'hi', sticker: bad });
    assert.equal(m.text, 'hi');
    assert.equal('sticker' in m, false, JSON.stringify(bad));
  }
  const mem = new chatLog.MemoryChatLog();
  const w = mem.append({ role: 'user', origin: 'user', turnId: 't', text: '', sticker: { ref: 'javascript:alert(1)', label: 'x' } });
  assert.equal('sticker' in w, false, 'not written either');
  // a label is cut to 20 characters and control characters are taken out
  const long = chatLog.cleanSticker({ ref: `blob:${SHA}.gif`, label: `超\u0000${'长'.repeat(40)}` });
  assert.equal([...long.label].length, 20);
  assert.ok(!/\u0000/.test(long.label));
});

// ---- the chat page's view, the agent's words -------------------------------------------------------------
test('messageView gives the chat page a sticker:// url and its label; buildConsoleBody / transcript put it in words', () => {
  const m = { id: 'm1', at: 1, role: 'user', turnId: 't', text: '', via: 'console', sticker: { ref: `blob:${SHA}.webp`, set: 'mine-claude', id: 'u2', label: '委屈' } };
  const v = AC.messageView(m, null, 'claude');
  assert.deepEqual(v.sticker, { url: `sticker://blob/${SHA}.webp`, label: '委屈', set: 'mine-claude', id: 'u2' });
  assert.equal(AC.messageView({ ...m, sticker: { ref: 'builtin:claude/think.webp', label: '想想' } }, null, 'claude').sticker.url, 'sticker://builtin/claude/think.webp');
  assert.equal(AC.messageView({ id: 'm2', at: 1, role: 'pet', text: 'hi' }, null, 'claude').sticker, null, 'an old message has none');
  // what the agent is told: the meaning in words, no picture
  const body = AC.buildConsoleBody({ name: '小克', text: '', sticker: { label: '委屈', desc: '眼泪汪汪，受了委屈' } });
  assert.match(body, /［主人发了一个表情包：「委屈」——眼泪汪汪，受了委屈］/);
  assert.match(AC.buildConsoleBody({ name: '小克', text: '你看', sticker: { label: '委屈' } }), /^你看\n\n［主人发了一个表情包：「委屈」］/);
  assert.equal(AC.buildConsoleBody({ name: '小克', text: '普通的一句' }), '普通的一句', 'without a sticker, as before');
  assert.match(AC.transcript([{ at: 1, role: 'user', text: '', sticker: { label: '委屈' } }, { at: 2, role: 'pet', text: '抱抱', sticker: { label: '摸头' } }], '小克'), /主人：［表情包：委屈］\n.*小克：抱抱［表情包：摸头］/);
});

test('StickerLibrary.resolve: only a set she holds; refUrl only for stored names', () => {
  const lib = new S.StickerLibrary(tmp());
  const sp = getSpecies('dafeiyu');
  const add = lib.add(sp, [{ name: '超开心.png', buffer: png(96, 96) }]);
  const mine = add.added[0];
  const r = lib.resolve(sp, 'mine-dafeiyu', mine.id);
  assert.deepEqual(r.sticker, { ref: `blob:${mine.blob}`, set: 'mine-dafeiyu', id: mine.id, label: '超开心', desc: '' });
  assert.equal(lib.resolve(sp, 'builtin:dafeiyu', 'rice').sticker.ref, 'builtin:dafeiyu/rice.webp');
  assert.equal(lib.resolve(sp, 'mine-claude', mine.id).ok, false, 'another character\'s set');
  assert.equal(lib.resolve(sp, 'builtin:claude', 'think').ok, false);
  assert.equal(lib.resolve(sp, 'mine-dafeiyu', '../x').ok, false);
  assert.equal(lib.resolveTag(sp, 'rice').id, 'rice');
  assert.equal(lib.resolveTag(sp, mine.id).set, 'mine-dafeiyu');
  assert.equal(S.refUrl(`blob:${mine.blob}`), `sticker://blob/${mine.blob}`);
  assert.equal(S.refUrl('blob:../../etc/passwd'), null);
});

// ---- PetService: the rounds ------------------------------------------------------------------------------
async function setup(species = 'dafeiyu') {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: new Date('2026-01-05T09:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const data = path.join(dir, 'data');
  const stickers = new S.StickerLibrary(path.join(data, 'stickers'));
  const svc = new PetService({ lh, store: new Store(data), now: () => clock.t, rnd: () => 0.5, log: new chatLog.ChatLog(data), stickers });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: species, name: '鱼片' });
  const runs = () => fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, data, clock, svc, stickers, runs };
}

test('chatAs with a sticker: kept in 聊天记录 as its own message, the agent gets its meaning, the page and history show it after a restart', async () => {
  const { svc, stickers, data, runs, clock } = await setup();
  const sp = getSpecies('dafeiyu');
  const own = stickers.add(sp, [{ name: '委屈.png', buffer: png(96, 96, [0, 0, 255]), desc: '眼泪汪汪' }]).added[0];
  const a = await svc.chatAs('dafeiyu', { sticker: { set: 'mine-dafeiyu', id: own.id } });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.userMessage.text, '');
  assert.deepEqual(a.userMessage.sticker, { ref: `blob:${own.blob}`, set: 'mine-dafeiyu', id: own.id, label: '委屈' });
  assert.match(runs().pop().prompt, /［主人发了一个表情包：「委屈」——眼泪汪汪］/, 'the agent hears what it means');
  assert.ok(a.message.text, 'she answered');
  clock.t += 60000;
  const b = await svc.chatAs('dafeiyu', { sticker: { set: 'builtin:dafeiyu', id: 'rice' } });
  assert.equal(b.ok, true);
  assert.ok(runs().pop().prompt.includes(`「${sp.memes.find((m) => m.id === 'rice').label}」`), 'a built-in one too');
  // a restart: a new service on the same folder reads both back
  const again = new PetService({ lh: svc.lh, store: new Store(data), log: new chatLog.ChatLog(data), stickers: new S.StickerLibrary(path.join(data, 'stickers')), now: () => clock.t });
  again.on('error', () => {});
  again.init();
  const page = again.chatHistory('dafeiyu');
  const shown = page.messages.map((m) => AC.messageView(m, null, 'dafeiyu')).filter((m) => m.sticker);
  assert.deepEqual(shown.map((m) => [m.role, m.sticker.url]), [['user', `sticker://blob/${own.blob}`], ['user', 'sticker://builtin/dafeiyu/rice.webp']]);
  const h = again.history();
  assert.equal(h.sessions[0].preview, '［表情包：委屈］');
  const sess = again.historySession(h.sessions[0].id).session;
  assert.deepEqual(sess.messages.filter((m) => m.sticker).map((m) => m.sticker.url), [`sticker://blob/${own.blob}`, 'sticker://builtin/dafeiyu/rice.webp']);
  // the left column's preview names the last sticker when the last message has no words
  assert.ok(svc.chatCharacters().characters.find((c) => c.id === 'dafeiyu'));
});

test('chatAs refuses a sticker that is not hers (another character\'s set, a deleted one) without logging anything', async () => {
  const { svc, stickers } = await setup();
  const before = svc.log.list().length;
  for (const pick of [{ set: 'builtin:claude', id: 'think' }, { set: 'mine-dafeiyu', id: 'u9' }, { set: '../x', id: 'rice' }]) {
    const r = await svc.chatAs('dafeiyu', { sticker: pick });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-sticker');
  }
  const own = stickers.add(getSpecies('dafeiyu'), [{ name: 'x.png', buffer: png(80, 80) }]).added[0];
  stickers.remove(getSpecies('dafeiyu'), [own.id]);
  assert.equal((await svc.chatAs('dafeiyu', { sticker: { set: 'mine-dafeiyu', id: own.id } })).reason, 'bad-sticker');
  assert.equal(svc.log.list().length, before);
});

test('her reply\'s [梗图:id] is kept with her message in 聊天记录 (chat page and desktop)', async () => {
  const { svc, dir } = await setup();
  fs.writeFileSync(path.join(dir, 'stream-reply.json'), JSON.stringify({ pieces: ['开饭啦'], gapMs: 1, final: '开饭啦\n[梗图:rice]' }));
  const r = await svc.chatAs('dafeiyu', { text: '饿了' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.message.text, '开饭啦');
  assert.deepEqual(r.message.sticker, { ref: 'builtin:dafeiyu/rice.webp', set: 'builtin:dafeiyu', id: 'rice', label: getSpecies('dafeiyu').memes.find((m) => m.id === 'rice').label });
  // the desktop chat box: the bubble's picture goes into 聊天记录 with the line
  const said = [];
  svc.on('say', (m) => said.push(m));
  const d = await svc.chat('再来一碗');
  assert.equal(d.ok, true);
  const last = svc.log.list().at(-1);
  assert.equal(last.role, 'pet');
  assert.equal(last.sticker && last.sticker.id, 'rice');
  assert.equal(said.at(-1).meme.id, 'rice');
});

test('desktop chat(): a sticker from the chat box panel is one round of 聊天记录; the HTTP API cannot send one', async () => {
  const { svc, runs } = await setup();
  const r = await svc.chat('', [], [], { sticker: { set: 'builtin:dafeiyu', id: 'cute' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const round = svc.log.list().filter((m) => m.kind === 'chat');
  assert.deepEqual(round.map((m) => [m.role, m.origin, m.sticker ? m.sticker.id : null]).slice(0, 1), [['user', 'user', 'cute']]);
  assert.match(runs().pop().prompt, /［主人发了一个表情包：「/);
  assert.equal(chatLog.userSessions(svc.log.list()).sessions[0].preview.startsWith('［表情包：'), true);
  // not from the local API (origin 'api'): the sticker is ignored, an empty message refused
  assert.equal((await svc.chat('', [], [], { origin: 'api', sticker: { set: 'builtin:dafeiyu', id: 'cute' } })).reason, 'empty');
  assert.equal((await svc.chat('', [], [], { sticker: { set: 'builtin:dafeiyu', id: 'nope' } })).reason, 'bad-sticker');
});
