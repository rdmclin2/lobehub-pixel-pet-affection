'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchDanceIntent, namedDance, pickOther } = require('../src/core/dance-intent');

const DANCES = [{ id: 'homemade-1133', name: '自制小舞 Homemade' }, { id: 'demo', name: '节拍摇摆' }, { id: 'gokuraku', name: '極楽浄土' }];

test('dance requests start a dance (any, or the one named)', () => {
  for (const s of ['跳个舞', '跳个舞吧', '给我跳支舞', '来段舞', '来一段舞！', '跳舞', '你会跳舞吗？跳个舞看看']) {
    assert.deepEqual(matchDanceIntent(s, DANCES), { action: 'start', id: null }, s);
  }
  assert.equal(matchDanceIntent('跳一下節拍摇摆', DANCES), null); // 跳一下 + no known name (traditional 節) is not a request
  assert.deepEqual(matchDanceIntent('跳一下节拍摇摆', DANCES), { action: 'start', id: 'demo' });
  assert.deepEqual(matchDanceIntent('跳《極楽浄土》', DANCES), { action: 'start', id: 'gokuraku' });
  assert.deepEqual(matchDanceIntent('跳个舞，就跳 homemade', DANCES), { action: 'start', id: 'homemade-1133' });
});

test('stops only while dancing', () => {
  for (const s of ['别跳了', '不要跳了', '停下', '停一下', '不跳了', '别跳舞']) {
    assert.deepEqual(matchDanceIntent(s, DANCES, { dancing: true }), { action: 'stop' }, s);
    assert.equal(matchDanceIntent(s, DANCES, { dancing: false }), null, s);
  }
});

test('not a dance request: other words with 跳 / 舞, negations, long messages', () => {
  for (const s of ['跳过这一步', '页面跳转了', '心跳好快', '舞台很大', '我不想跳舞', '我不会跳舞', '跳一下试试', '今天天气不错', '']) {
    assert.equal(matchDanceIntent(s, DANCES), null, s);
  }
  assert.equal(matchDanceIntent(`${'今天'.repeat(30)}跳个舞`, DANCES), null);
});

test('namedDance prefers the longest name; pickOther avoids the last one', () => {
  assert.equal(namedDance('跳 homemade', DANCES), 'homemade-1133');
  assert.equal(namedDance('x', DANCES), null);
  for (let i = 0; i < 20; i++) assert.notEqual(pickOther(DANCES, ['demo']).id, 'demo');
  assert.equal(pickOther([{ id: 'demo' }], ['demo']).id, 'demo');
  assert.equal(pickOther([], []), null);
});
