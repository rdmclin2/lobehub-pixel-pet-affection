'use strict';
// 对话语音: a reply is read whole, sentence by sentence (core/voice.js sentences()), with the same
// filtering as before (no emoji, stage directions in brackets, meme tags, links).

const test = require('node:test');
const assert = require('node:assert/strict');
const Voice = require('../src/core/voice');

const said = (t) => Voice.sentences(t).filter((p) => p.say).map((p) => p.say);
const len = (s) => [...s].length;

test('a reply is cut into its sentences, in order', () => {
  assert.deepEqual(said('你好呀，今天天气不错。我们去散步吧！你想去哪里？'), ['你好呀，今天天气不错。', '我们去散步吧！', '你想去哪里？']);
  assert.deepEqual(said('第一行写点什么\n第二行再写点什么'), ['第一行写点什么', '第二行再写点什么']);
  assert.deepEqual(said('Hello there. I am fine! Are you ok?'), ['Hello there.', 'I am fine!', 'Are you ok?']);
  assert.deepEqual(said('这是真的吗？！太好了……我好开心～'), ['这是真的吗？！', '太好了……我好开心～'], 'end marks stay with their sentence');
  assert.deepEqual(said('她说：“走吧。”然后就走了。'), ['她说：“走吧。”', '然后就走了。'], 'a closing quote stays with its sentence');
});

test('the pieces put together are exactly the reply, so the bubble can mark the one being read', () => {
  for (const t of ['哈！😀（得意）[梗图:roast] 看 https://x.y/a.b 这个。下一句！', '（摇尾巴。）你来啦。嗯。', '很长的一句话，'.repeat(40) + '完。', '', 'abc']) {
    assert.equal(Voice.sentences(t).map((p) => p.raw).join(''), t);
  }
});

test('emoji, stage directions, meme tags and links are still not read', () => {
  assert.deepEqual(said('哈！😀（得意）[梗图:roast] 看 https://x.y/a.b 这个'), ['哈！ 看 这个']);
  assert.deepEqual(said('（开心地摇尾巴。）你想去哪里？我想去公园。'), ['你想去哪里？', '我想去公园。'], 'a full stop inside brackets does not end a sentence');
  assert.deepEqual(said('【旁白：夜深了。】晚安，明天见。'), ['晚安，明天见。']);
  assert.deepEqual(said('(｡･ω･｡) 🎉 [梗图:cheer]'), [], 'nothing to say: nothing read');
  const parts = Voice.sentences('今天好累啊。（趴下）（叹气）');
  assert.equal(parts.length, 1, 'a trailing stage direction joins the sentence before it');
  assert.equal(parts[0].say, '今天好累啊。');
});

test('very short sentences are read together with the next', () => {
  assert.deepEqual(said('嗯。我知道你的意思了。'), ['嗯。我知道你的意思了。']);
  assert.deepEqual(said('我知道你的意思了。嗯。'), ['我知道你的意思了。', '嗯。'], 'a short last sentence stays on its own');
});

test('no half sentences: a long reply is read whole; an overlong sentence is cut at commas', () => {
  const long = '很长的一句话。'.repeat(25);
  assert.equal(said(long).join(''), long, 'every sentence of a 175-character reply is read');
  const run = '这是一个特别特别长的分句，'.repeat(20) + '最后结束。';
  const pieces = said(run);
  assert.ok(pieces.length > 1);
  for (const p of pieces) assert.ok(len(p) <= Voice.MAX_SENTENCE, `${len(p)} chars`);
  for (const p of pieces.slice(0, -1)) assert.match(p, /，$/, 'cut at a comma');
  assert.equal(pieces.join(''), run);
  const noComma = '啊'.repeat(300);
  assert.deepEqual(said(noComma).map(len), [120, 120, 60], 'no comma at all: a hard cut as the last resort');
});

test('past MAX_SENTENCES the rest stays on screen only', () => {
  const parts = Voice.sentences('这是一句话呀。'.repeat(Voice.MAX_SENTENCES + 5));
  assert.equal(parts.filter((p) => p.say).length, Voice.MAX_SENTENCES);
  assert.equal(parts.length, Voice.MAX_SENTENCES + 5);
});

test('an unclosed bracket ends with its line', () => {
  assert.deepEqual(said('（小声嘀咕了好一会儿\n算了。不说了，你忙吧。'), ['（小声嘀咕了好一会儿', '算了。不说了，你忙吧。']);
});
