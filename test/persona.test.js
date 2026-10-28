'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const { buildSystemRole, buildStateBlock, buildEventPrompt } = require('../src/core/persona');
const st = require('../src/core/pet-state');

test('system role carries name, species personality and a Chinese-by-default rule', () => {
  for (const [id, zh] of [['testchan', '测试娘'], ['grok', '格萝可'], ['claude', '克洛蒂'], ['dafeiyu', '大肥鱼']]) {
    const r = buildSystemRole({ speciesId: id, name: '小测' });
    assert.match(r, /小测/);
    assert.match(r, new RegExp(zh));
    assert.match(r, /简体中文/);
  }
});

test('state block reflects hunger and time without leaking raw numbers', () => {
  const now = new Date('2026-01-05T08:05:00').getTime();
  const p = st.createPet({ speciesId: 'testchan', name: 'E', agentId: 'a', now });
  p.hunger = 90;
  const b = buildStateBlock(p, now);
  assert.match(b, /很饿/);
  assert.match(b, /08:05/);
  assert.doesNotMatch(b, /90/);
});

test('event prompts start with the state block and an [事件] marker', () => {
  const now = Date.now();
  const p = st.createPet({ speciesId: 'grok', name: 'B', agentId: 'a', now });
  const prompt = buildEventPrompt('hungry', p, now);
  assert.match(prompt, /^\[状态\]/);
  assert.match(prompt, /\n\[事件\] /);
});

test('the persona keeps replies short and heavy work one step at a time, without refusing helpful tasks', () => {
  const r = buildSystemRole({ speciesId: 'testchan', name: 'E' });
  assert.match(r, /50 个字以内/);
  assert.match(r, /一件一件来/);
  assert.match(r, /联网搜索/);
  assert.doesNotMatch(r, /你是宠物，不是助手/);
  assert.doesNotMatch(r, /提醒主人去找其他助手/);
});

// ---------------------------------------------------------------- affection version
const { PERSONA_VERSION, CONTENT_RULES, buildTopicPrompt, buildChatPrompt } = require('../src/core/persona');
const { getTopic } = require('../src/core/dialogue');
const ADULT = { ageConfirmed: true, adultContent: true };
const OFF = { ageConfirmed: true, adultContent: false };
const at = (affection, speciesId = 'testchan') => {
  const now = new Date('2026-01-05T10:00:00').getTime();
  const p = st.createPet({ speciesId, name: 'E', agentId: 'a', now });
  st.setAffectionForTest(p, affection);
  return { p, now };
};

test('persona v7: the character is an adult, the relationship stages are explained and the content red lines are in the role', () => {
  assert.equal(PERSONA_VERSION, 7);
  for (const id of ['testchan', 'grok', 'claude', 'dafeiyu']) {
    const r = buildSystemRole({ speciesId: id, name: 'X' });
    assert.match(r, /你是成年人/);
    assert.match(r, /25 岁以上/);
    assert.match(r, /陌生 → 熟悉 → 亲近 → 暧昧 → 恋人/);
    assert.ok(r.includes(CONTENT_RULES));
    for (const rule of [/露骨/, /强迫/, /未成年人/, /真实人物/, /违法/]) assert.match(r, rule);
    assert.doesNotMatch(r, /幼崽|少年|成长阶段|破壳/);
  }
});

test('the [状态] block carries the relationship stage and affection; a [关系] block follows', () => {
  const { p, now } = at(42);
  const b = buildStateBlock(p, now, OFF);
  assert.match(b, /^\[状态\] 关系=亲近；好感=42\/100；/);
  assert.match(b, /\n\[关系\] 阶段=亲近；成人向=关，只用全年龄语气；允许=[^；]*撒娇/);
  assert.match(b, /已解锁话题=[^；]*撒娇模式/);
  assert.doesNotMatch(b, /阶段=幼崽|阶段=少年/);
});

test('the scope changes with the stage, so replies change with it', () => {
  const a = buildStateBlock(at(0).p, at(0).now, OFF);
  const b = buildStateBlock(at(40).p, at(40).now, OFF);
  assert.match(a, /关系=陌生/);
  assert.match(a, /已解锁话题=自我介绍、今天天气怎么样；/);
  assert.match(b, /关系=亲近/);
  assert.notEqual(a.split('\n')[1], b.split('\n')[1]);
});

test('adult content off: flirty stage reads 知己 with all-ages tone; on: 暧昧 with flirting allowed', () => {
  const { p, now } = at(70);
  const off = buildStateBlock(p, now, OFF);
  assert.match(off, /关系=知己/);
  assert.match(off, /成人向=关，只用全年龄语气/);
  assert.doesNotMatch(off, /调情|调戏一下|吃醋模式/);
  const none = buildStateBlock(p, now); // no settings at all = all-ages
  assert.match(none, /成人向=关/);
  const on = buildStateBlock(p, now, ADULT);
  assert.match(on, /关系=暧昧/);
  assert.match(on, /成人向=开/);
  assert.match(on, /调情/);
  assert.match(on, /调戏一下/);
  const fish = at(70, 'dafeiyu');
  assert.match(buildStateBlock(fish.p, fish.now, ADULT), /关系=知己；.*成人向=关/s);
});

test('topic prompts use the [话题] marker and keep adult topics clean', () => {
  const { p, now } = at(70);
  const t = getTopic(p, ADULT, 'tease').topic;
  const prompt = buildTopicPrompt(t, p, now, ADULT);
  assert.match(prompt, /\n\[话题\] 调戏一下：/);
  assert.match(prompt, /不露骨/);
  assert.match(buildChatPrompt('hi', p, now, { settings: ADULT }), /\[关系\]/);
});

const { personaKey } = require('../src/core/persona');
const role = (affection, settings, speciesId = 'testchan') => {
  const { p } = at(affection, speciesId);
  return buildSystemRole({ speciesId, name: 'E', pet: p, settings });
};

test('the system role itself carries the current stage, its tone and the unlocked topics, and differs by stage', () => {
  const low = role(0, OFF);
  const mid = role(40, OFF);
  const high = role(90, ADULT);
  assert.notEqual(low, mid);
  assert.notEqual(mid, high);
  assert.match(low, /当前关系（随好感度变化，以此为准）：阶段=陌生（第 1\/5 阶段）/);
  assert.match(low, /允许的语气：礼貌、有分寸/);
  assert.match(low, /已解锁话题：自我介绍、今天天气怎么样。/);
  assert.match(low, /还没解锁：[^。]*撒娇模式/);
  assert.match(low, /下一阶段：熟悉（好感 15）/);
  assert.match(mid, /阶段=亲近（第 3\/5 阶段）/);
  assert.match(mid, /已解锁话题：[^。]*撒娇模式/);
  assert.match(high, /阶段=恋人（第 5\/5 阶段）；成人向=开/);
  assert.match(high, /情侣称呼/);
  assert.match(high, /已是最高阶段/);
  for (const r of [low, mid, high]) assert.ok(r.includes(CONTENT_RULES));
  // with no pet (agent creation) it is the first stage
  assert.match(buildSystemRole({ speciesId: 'testchan', name: 'E' }), /阶段=陌生（第 1\/5 阶段）/);
});

test('adult content off: the system role offers only all-ages tone and never names adult topics, even locked', () => {
  for (const r of [role(90, OFF), role(90, null), role(90, ADULT, 'dafeiyu')]) {
    assert.match(r, /阶段=挚友（第 5\/5 阶段）；成人向=关，只用全年龄语气/);
    const section = r.slice(r.indexOf('当前关系'), r.indexOf('内容红线'));
    assert.doesNotMatch(section, /调戏一下|吃醋模式|情侣称呼|调情/);
  }
  assert.match(role(70, ADULT), /调戏一下/);
});

test('personaKey changes with the stage and the adult switch, not with needs', () => {
  const a = at(10).p;
  const k = personaKey(a, OFF);
  a.hunger = 99;
  assert.equal(personaKey(a, OFF), k);
  assert.notEqual(personaKey(at(40).p, OFF), k);
  assert.notEqual(personaKey(at(70).p, OFF), personaKey(at(70).p, ADULT));
});
