// 实施包 B（docs/admin-audit/02-plan.md §5.3）: the settings window's character object model —
// 角色（base）→ 形象（pack）, one count wording, the four states, the detail-tab routes (B01 / B02 / B09 / B12 / B13).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../admin/src/console/roster-model.ts')).href);

const row = (id, base, o = {}) => ({ accent: '#f00', base, current: false, id, kind: 'sprites', label: o.label ?? '像素', met: null, nameZh: base === 'dafeiyu' ? '大肥鱼' : base, source: 'builtin', ...o });

test('groupRoster: one character per base, four states, the lead look', async () => {
  const { groupRoster, STATE_WORD } = await load();
  const roster = [
    row('dafeiyu-pixel', 'dafeiyu'),
    row('dafeiyu-live2d', 'dafeiyu', { kind: 'live2d', label: 'Live2D', source: 'download' }),
    row('grok', 'grok', { met: { name: '小格', affection: 3 } }),
    row('grok-old', 'grok', { current: true, met: { name: '小格', affection: 3 } }),
    row('claude', 'claude', { met: { name: '克克', affection: 0 } }),
  ];
  const catalog = [{ base: 'gemini', id: 'gemini-pixel', installed: false, name: '杰米 · 像素' }, { base: 'dafeiyu', id: 'dafeiyu-rig', installed: false, name: '大肥鱼 · 全动态' }];
  const g = groupRoster(roster, catalog);
  assert.deepEqual(g.map((x) => [x.base, x.state, x.lead?.id ?? null, x.looks.length]), [
    ['dafeiyu', 'unmet', 'dafeiyu-pixel', 2],
    ['grok', 'current', 'grok-old', 2],
    ['claude', 'met', 'claude', 1],
    ['gemini', 'unowned', null, 0],
  ]);
  assert.equal(g[0].remote.length, 1, 'her downloadable look is counted under her');
  assert.equal(g[1].name, '小格', 'a named character goes by her name');
  assert.deepEqual(Object.values(STATE_WORD), ['正在陪你', '已遇见', '还没见面', '未拥有']);
  // a filter picks the lead among the matching looks
  const l2d = groupRoster(roster, [], (c) => c.kind === 'live2d').filter((x) => x.lead);
  assert.deepEqual(l2d.map((x) => x.lead.id), ['dafeiyu-live2d']);
});

test('countLabel / metCount: 「N 位角色 · M 套形象」, met counted per character', async () => {
  const { countLabel, metCount } = await load();
  const roster = [row('a1', 'a', { met: { name: 'A' } }), row('a2', 'a', { met: { name: 'A' } }), row('b1', 'b')];
  assert.equal(countLabel(roster), '2 位角色 · 3 套形象');
  assert.equal(metCount(roster), 1);
});

test('resolveCharacter / lookName: an old base link resolves like her page; names follow 名字 · 形象', async () => {
  const { resolveCharacter, lookName } = await load();
  const roster = [row('dafeiyu-pixel', 'dafeiyu'), row('dafeiyu-live2d', 'dafeiyu', { current: true, label: 'Live2D', met: { name: '鱼鱼' } })];
  assert.equal(resolveCharacter(roster, 'dafeiyu-pixel').id, 'dafeiyu-pixel');
  assert.equal(resolveCharacter(roster, 'dafeiyu').id, 'dafeiyu-live2d', 'base id → the look with you');
  assert.equal(resolveCharacter(roster, 'nobody'), undefined);
  assert.equal(lookName(roster[1]), '鱼鱼 · Live2D');
  assert.equal(lookName(roster[0]), '大肥鱼 · 像素');
});

test('detail tabs: `#/characters/:id/:tab`, old tab names land on the merged ones', async () => {
  const { toDetailTab, detailHref } = await load();
  assert.equal(toDetailTab('model'), 'model');
  assert.equal(toDetailTab('voice'), 'about', '语音 + 资料 → 资料与语音 (CHAR-04)');
  assert.equal(toDetailTab('outfits'), 'looks');
  assert.equal(toDetailTab(undefined), 'looks');
  assert.equal(toDetailTab('nope'), 'looks');
  assert.equal(detailHref('grok', 'affection'), '#/characters/grok/affection');
});
