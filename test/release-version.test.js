'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveVersion, latestStable } = require('../scripts/release-version');

const TAGS = ['v0.8.0', 'v0.9.0', 'v0.10.0-canary.1', 'v0.5.1', 'not-a-tag'];

test('a release PR title releases exactly its version', () => {
  const r = resolveVersion({ title: '🚀 release: v0.10.0', tags: TAGS });
  assert.deepEqual([r.release, r.version, r.kind], [true, '0.10.0', 'release']);
  assert.equal(resolveVersion({ title: '🚀 release: v1.0.0-beta.1' }).version, '1.0.0-beta.1');
});

test('feat / fix / style / refactor / perf / hotfix / build PRs release the latest stable tag + patch', () => {
  for (const title of ['✨ feat(voice): 互动语音', '🐛 fix(ui): every panel opens at its top', 'fix: x', '💄 style: y', '♻️ refactor(core): z', '⚡️ perf: p', '🩹 hotfix: h', '👷 build: b', '✨ feat!: breaking']) {
    const r = resolveVersion({ title, tags: TAGS });
    assert.deepEqual([r.release, r.version, r.kind], [true, '0.9.1', 'patch'], title);
  }
});

test('hotfix/* and release/* branches release whatever their title', () => {
  assert.equal(resolveVersion({ title: '📝 docs: notes', head: 'hotfix/crash', tags: TAGS }).version, '0.9.1');
  assert.equal(resolveVersion({ title: 'whatever', head: 'release/0.9.1', tags: TAGS }).release, true);
});

test('docs, chore, test, ci and merge commits release nothing', () => {
  for (const title of ['📝 docs(voice): README', '🔖 chore(release): v0.9.0', '✅ test(e2e): models', '👷 ci: workflows', "Merge branch 'main' into canary", '', 'release: v1.0.0', 'feature: not a type']) {
    const r = resolveVersion({ title, tags: TAGS });
    assert.equal(r.release, false, title);
    assert.equal(r.version, null, title);
  }
});

test('without a stable tag the patch bump starts from package.json', () => {
  assert.equal(resolveVersion({ title: 'fix: x', tags: [], pkgVersion: '0.9.0' }).version, '0.9.1');
  assert.equal(resolveVersion({ title: 'fix: x', tags: ['v1.0.0-canary.3'], pkgVersion: '0.2.0' }).version, '0.2.1');
});

test('latestStable compares numerically and ignores pre-releases', () => {
  assert.deepEqual(latestStable(['v0.9.0', 'v0.10.0', 'v0.2.1', 'v1.0.0-rc.1']), [0, 10, 0]);
  assert.equal(latestStable(['v1.0.0-rc.1']), null);
});
