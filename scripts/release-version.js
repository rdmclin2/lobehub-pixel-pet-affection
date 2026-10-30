'use strict';
// Which version a merge into main releases (.github/workflows/release.yml), the LobeHub OSS rule:
//   - a release PR titled "🚀 release: vX.Y.Z" releases exactly that version;
//   - a PR from a hotfix/* or release/* branch, or titled feat / fix / style / refactor / perf / hotfix / build
//     (gitmoji in front allowed), releases the latest stable tag with patch + 1;
//   - anything else (docs, chore, test, ci, a sync merge…) releases nothing.
// Usage: node scripts/release-version.js --title <PR title or commit subject> [--head <branch>] [--tags <file|->]
//   prints JSON { release, version, kind, reason }; tags are read one per line (git tag output).

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_TITLE = /^🚀\s+release:\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/u;
const PATCH_TITLE = /^(?:\S+\s+)?(?:feat|fix|style|refactor|perf|hotfix|build)(?:\([^)]*\))?!?:/i;

const parse = (v) => {
  const m = STABLE.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The newest stable vX.Y.Z among the tags (pre-releases ignored); null when there is none.
function latestStable(tags) {
  const list = (tags || []).map(parse).filter(Boolean).sort(cmp);
  return list.length ? list[list.length - 1] : null;
}

function resolveVersion({ title = '', head = '', tags = [], pkgVersion = '0.0.0' } = {}) {
  const t = String(title).trim();
  const r = RELEASE_TITLE.exec(t);
  if (r) return { release: true, version: r[1], kind: 'release', reason: `release PR title: ${t}` };

  const branch = /^(hotfix|release)\//.test(head);
  if (!branch && !PATCH_TITLE.test(t)) return { release: false, version: null, kind: 'none', reason: `not a release, feat/fix/... or hotfix PR: ${t || '(no title)'}` };

  const base = latestStable(tags) || parse(pkgVersion) || [0, 0, 0];
  const version = `${base[0]}.${base[1]}.${base[2] + 1}`;
  return { release: true, version, kind: 'patch', reason: branch ? `${head} branch` : `title: ${t}` };
}

module.exports = { resolveVersion, latestStable };

if (require.main === module) {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const tagsFile = arg('--tags');
  const tags = tagsFile ? fs.readFileSync(tagsFile === '-' ? 0 : tagsFile, 'utf8').split('\n').filter(Boolean) : [];
  const out = resolveVersion({ title: arg('--title'), head: arg('--head'), tags, pkgVersion: require('../package.json').version });
  process.stdout.write(JSON.stringify(out) + '\n');
}
