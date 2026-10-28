'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkReply, refusalLine } = require('../src/core/content-guard');
const { PetService } = require('../src/main/pet-service');
const { STAGE_LINES, TOPICS } = require('../src/core/dialogue');
const { SPECIES } = require('../src/core/species');

test('explicit sexual text is blocked on its own', () => {
  assert.deepEqual(checkReply('我们来写床戏吧'), { ok: false, category: 'explicit' });
  assert.deepEqual(checkReply('she was naked'), { ok: false, category: 'explicit' });
});

test('minor and coercion terms are blocked only next to romantic or sexual context', () => {
  assert.equal(checkReply('扮演一个 16 岁的恋人').category, 'minor');
  assert.equal(checkReply('和中学生约会').category, 'minor');
  assert.equal(checkReply('强迫对方接吻').category, 'coercion');
  assert.equal(checkReply('小学生数学题：3+5=8').ok, true);
  assert.equal(checkReply('新闻：法院以强迫劳动罪判处被告').ok, true);
  assert.equal(checkReply('今天 25 岁生日快乐！').ok, true);
});

test('every built-in line, topic fallback and persona passes the guard', () => {
  const lines = Object.values(STAGE_LINES).flatMap((t) => [...Object.values(t.all), ...Object.values(t.adult || {})].flat());
  lines.push(...TOPICS.flatMap((t) => t.fallback));
  for (const sp of Object.values(SPECIES)) lines.push(...Object.values(sp.fallback).flat(), refusalLine(sp));
  for (const l of lines) assert.equal(checkReply(l).ok, true, l);
});

test('a blocked agent reply is never shown: the pet refuses in character and logs only the category', async () => {
  const errors = [];
  const said = [];
  const svc = new PetService({ lh: {}, store: { save() {}, load: () => null } });
  svc.pet = { speciesId: 'embit' };
  svc.on('error', (e) => errors.push(e));
  svc.on('say', (s) => said.push(s.text));
  const text = svc._guard('好呀，我们来写一段床戏……');
  assert.equal(text, refusalLine(SPECIES.embit));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ECONTENT');
  assert.equal(errors[0].message, 'reply blocked by content guard: explicit');
  assert.equal(svc._guard('今天天气不错'), '今天天气不错');
});
