#!/usr/bin/env node
'use strict';
// 插个嘴 demo (docs/interject.md §7): the real PetService + core/interject.js + settings.js, with the fake `lh`
// (test/fixtures/fake-lh.js) standing in for LobeHub — `lh generate decide` answers whatever probability this script
// writes to decide.json (the mock), `lh agent run` writes her line (the same bubble path as every other line).
// Prints every step: input → prefilter → probability vs thresholds → her line / why she stayed quiet → feedback →
// the rule it created → the next input of that kind blocked by the rule (no decision call).
//
//   node scripts/interject-demo.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const settingsLib = require('../src/core/settings');
const { InterjectStore } = require('../src/core/interject');
const { PetService } = require('../src/main/pet-service');

const FAKE = path.join(__dirname, '..', 'test', 'fixtures', 'fake-lh.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interject-demo-'));
fs.writeFileSync(path.join(dir, 'loggedin'), '1');
const MIN = 60000;
const clock = { t: new Date('2026-11-03T15:00:00').getTime() };
const decideLog = path.join(dir, 'decide-calls.jsonl');
const decideCalls = () => (fs.existsSync(decideLog) ? fs.readFileSync(decideLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const mock = (probability) => fs.writeFileSync(path.join(dir, 'decide.json'), JSON.stringify(probability === 'fail' ? { mode: 'fail' } : { probability }));
const out = (s = '') => console.log(s);

function show(rec, cfg) {
  if (!rec) return out('  → (nothing judged)');
  out(`  输入摘要: ${rec.summary}  [来源 ${rec.source} · 类别 ${rec.category} · 时段 ${rec.bucket}]`);
  if (rec.stage === 'prefilter') return out(`  预过滤: 拦下（${rec.reason}${rec.ruleIds ? `，规则 ${rec.ruleIds.join(',')}` : ''}）→ 不调用 jev，不说话`);
  out('  预过滤: 通过');
  if (rec.stage === 'error') return out(`  jev: 失败（${rec.reason}，code ${rec.errorCode}）→ 一律不说话`);
  const p = rec.probability;
  const cmp = p === null ? '无有效概率' : p >= cfg.highThreshold ? `${p} ≥ 高阈值 ${cfg.highThreshold}` : p <= cfg.lowThreshold ? `${p} ≤ 低阈值 ${cfg.lowThreshold}` : `${cfg.lowThreshold} < ${p} < ${cfg.highThreshold}（中间区间）`;
  out(`  jev 概率: ${cmp} → ${rec.reason}`);
  out(rec.said ? `  插嘴（${rec.via}，经 agent run → 气泡）: 「${rec.said}」` : `  不插嘴（${rec.reason}）`);
}

(async () => {
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const settingsStore = new settingsLib.SettingsStore(path.join(dir, 'data'));
  settingsStore.save({ ageGateVersion: 2, answered: true }); // an existing user's file: no `interject` section yet
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), settingsStore, interjectStore: new InterjectStore(path.join(dir, 'data')), now: () => clock.t, timers: { setTimeout: () => ({}), clearTimeout: () => {} } });
  svc.on('error', () => {});
  const bubbles = [];
  svc.on('say', (m) => { if (m.kind === 'interject') bubbles.push(m); });
  await svc.hatch({ speciesId: 'claude', name: '小芽' });
  clock.t += 30 * MIN;

  out('== 0. 默认配置（旧 settings.json 迁移后）');
  out(`  settings.interject = ${JSON.stringify(svc.settings.interject)}`);
  out('\n== 1. 开关关闭：三种来源各来一条输入');
  for (const src of ['chatDraft', 'voice', 'api']) out(`  interjectInput('${src}') → ${JSON.stringify(svc.interjectInput(src, '终于把这个 bug 修好了！累死我了'))}`);
  await svc.interjector.flush();
  await svc.chat('你好呀');
  await svc.heartbeat();
  out(`  lh generate decide 调用次数: ${decideCalls()}`);

  out('\n== 2. 打开插个嘴（setSection("interject", { enabled: true })，与设置窗口同一 setter）');
  svc.setSection('interject', { enabled: true });
  const cfg = svc.settings.interject;
  out(`  enabled=${cfg.enabled} sources=${JSON.stringify(cfg.sources)} 阈值 ${cfg.lowThreshold}/${cfg.highThreshold} 冷却 ${cfg.cooldownMin} 分钟 模型 ${cfg.model}`);

  const step = async (title, source, text, p, advance = 0) => {
    clock.t += advance * MIN;
    out(`\n== ${title}`);
    out(`  输入（${source}）: ${text}`);
    if (p !== undefined) mock(p);
    const before = decideCalls();
    const acc = svc.interjectInput(source, text);
    if (!acc.accepted) return out(`  未接收: ${acc.reason}`);
    const rec = await svc.interjector.flush();
    show(rec, cfg);
    out(`  本步 decide 调用: ${decideCalls() - before}（累计 ${decideCalls()}）`);
    return rec;
  };

  const r1 = await step('3. 判断 → 插嘴（mock 概率 0.86）', 'chatDraft', '终于把这个 bug 修好了！累死我了', 0.86, 2);
  out(`  气泡事件: ${JSON.stringify({ kind: bubbles[0].kind, source: bubbles[0].source, text: bubbles[0].text })}`);
  const last = JSON.parse(fs.readFileSync(decideLog, 'utf8').trim().split('\n').pop());
  out(`  jev 收到的 state:\n${last.state.split('\n').map((l) => `    ${l}`).join('\n')}`);

  out('\n== 4. 反馈：主人紧接着在聊天框里说「别打扰我，正写代码呢」');
  clock.t += MIN;
  await svc.chat('别打扰我，正写代码呢');
  const d1 = svc.interjectDecisions().decisions.find((d) => d.id === r1.id);
  out(`  判断记录 ${d1.id} feedback = ${d1.feedback}`);
  const rules = svc.interjectRules().rules;
  out(`  沉淀的规则: ${JSON.stringify(rules)}`);

  await step('5. 规则生效：同类（写代码）输入被本地拦下', 'chatDraft', 'npm test 又报错了，stack trace 一大串', 0.95, 15);
  await step('6. 判断 → 不插嘴（mock 概率 0.2，其他类别）', 'voice', '提醒我明天早上九点交报告', 0.2, 1);
  await step('7. 中间区间默认不插嘴（mock 概率 0.55）', 'chatDraft', '中午吃什么好纠结', 0.55, 1);
  const r8 = await step('8. jev 失败 → 不说话（mock exit 1）', 'chatDraft', '晚上去吃火锅还是烧烤呢', 'fail', 1);
  void r8;
  const r9 = await step('9. 判断 → 插嘴（0.8，吃喝）', 'chatDraft', '奶茶店今天买一送一诶', 0.8, 1);
  out('\n== 10. 反馈：主人点 👍（interjectFeedback(id, "like")）');
  const fb = svc.interjectFeedback(r9.id, 'like');
  out(`  新规则: ${JSON.stringify(fb.rule)}`);
  await step('11. 规则生效：吃喝类中间区间（0.55）现在也插嘴', 'chatDraft', '下午茶点个蛋糕要不要', 0.55, 11);

  out('\n== 12. 规则查看 / 删除接口');
  out(`  interjectRules() → ${svc.interjectRules().rules.map((r) => `${r.id} ${r.note} (hits ${r.hits})`).join(' | ')}`);
  const blockId = svc.interjectRules().rules.find((r) => r.effect === 'block').id;
  out(`  interjectDeleteRule('${blockId}') → ${JSON.stringify(svc.interjectDeleteRule(blockId))}`);
  await step('13. 每小时上限：这一小时已插嘴 3 次（maxPerHour=3）', 'chatDraft', 'git push 被拒绝了冲突好多', 0.9, 11);
  await step('13b. 一小时后：删掉的规则不再拦，写代码类重新进入判断（0.4，中间区间，无 allow 规则 → 不说）', 'chatDraft', 'git rebase 又冲突了，头大', 0.4, 50);

  out('\n== 14. 落盘的 interject.json（判断记录与规则）');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'interject.json'), 'utf8'));
  out(`  rules: ${file.rules.length} 条；decisions: ${file.decisions.length} 条`);
  out(`  decisions: ${JSON.stringify(file.decisions.map(({ summary, source, category, stage, reason, probability, verdict, feedback, ruleIds }) => ({ summary, source, category, stage, reason, probability, verdict, ...(feedback ? { feedback } : {}), ...(ruleIds ? { ruleIds } : {}) })), null, 1)}`);
  out(`\n总计 decide 调用 ${decideCalls()} 次；插嘴 ${bubbles.length} 次。数据目录: ${dir}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
