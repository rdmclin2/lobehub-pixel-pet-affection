'use strict';

// T-5089: the tables of the multi-model check, from out/e2e/vrm/verify-summary.json (e2e/vrm-verify.js):
//   node e2e/vrm-verify-report.js [summary.json] > tables.md
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, '..', 'out', 'e2e', 'vrm', 'verify-summary.json');
const S = JSON.parse(fs.readFileSync(file, 'utf8'));
const KEY = ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg'];
const f = (x, d = 2) => (x === null || x === undefined ? '—' : typeof x === 'number' ? String(+x.toFixed(d)) : String(x));
const pc = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const out = [];
const p = (s = '') => out.push(s);

p('## 总表');
p();
p('| 模型 | VRM | 风格 | 头高 / 腿长占比 | 片段数 | idle 命中率 | 不同 idle 片段 | 切换次数 | 姿势休息 | 跳变尖峰最大（°/帧@30fps） | 回 idle（触摸 头/手/肚，s） | 落地→idle（s） | 舞蹈 Esc→idle（s） | 双臂平举（T-pose）| 判定 |');
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of S.models) {
  const t = (r.touch || []).map((o) => f(o.backToIdleS)).join(' / ');
  const rest = r.rest ? (r.rest.seen ? `${r.rest.pose}（+${r.rest.afterS}s）` : r.rest.rootHips ? '只站（hips 在地面）' : '未出现') : '—';
  p(`| ${r.id} | ${r.vrm} | ${r.style && r.style.name}(${r.style && r.style.source}) | ${f(r.proportions && r.proportions.headAboveAnkle, 2)} m / ${f(r.proportions && r.proportions.legShare, 2)} | ${r.clips} | ${r.idle ? `${pc(r.idle.hitRatio)}（${r.idle.hits}/${r.idle.samples}）` : '—'} | ${r.idle ? r.idle.distinctClips : '—'} | ${r.idle ? r.idle.switches : '—'} | ${rest} | ${r.jump ? `${f(r.jump.spikeMax)}（${r.jump.transitions} 次切换）` : '—'} | ${t || '—'} | ${f(r.drag && r.drag.backToIdleS)} | ${f(r.dance && r.dance.backToIdleS)} | ${(r.tpose || []).length ? r.tpose.map((v) => `${v.seconds}s ${v.base}`).join('；') : '无'} | ${r.passed ? '通过' : `**失败**：${r.failures.join('；') || '有步骤未完成'}`} |`);
}
p();

for (const r of S.models) {
  p(`## ${r.id}（VRM ${r.vrm}，${r.style && r.style.name}）`);
  p();
  if (r.idle) {
    p(`- idle ${S.idleSeconds} s：${r.idle.samples} 个 100 ms 采样，库片段命中 ${r.idle.hits}/${r.idle.samples} = ${pc(r.idle.hitRatio)}；${r.idle.distinctClips} 个不同片段：${r.idle.clipSequence.join(' → ')}`);
    p(`- 片段之间的姿势差（平均姿态，最大骨骼 / 18 骨平均）：${(r.idle.poseDelta || []).map((d) => `${d.from}→${d.to} ${d.maxDeg}°（${d.maxBone}）/ ${d.meanDeg}°`).join('；') || '—'}`);
    p(`- 运动骨骼 ${r.idle.movingBones}/18（转幅 ≥ 1°），全身平均角速度 ${r.idle.meanSpeedAll}°/s，9 骨转幅和 ${r.idle.key9RangeSum}°；主频占比中位 ${r.idle.dominantShareMedian}（最大 ${r.idle.dominantShareMax}），单一正弦骨骼（占比 > 0.8 且转幅 ≥ 1°）：${r.idle.singleSineBones.join(', ') || '无'}；膝盖最小 ${r.idle.kneesMin}°`);
    p();
    p('| 骨骼 | 均值 °/s | 标准差 | p50 | p95 | 最大 | 转幅 ° | 静止占比 | 主频占比（Hz） |');
    p('|---|---|---|---|---|---|---|---|---|');
    for (const b of KEY) {
      const v = r.idle.boneStats[b];
      if (!v) continue;
      p(`| ${b} | ${v.speedMean} | ${v.speedSd} | ${v.speedP50} | ${v.speedP95} | ${v.speedMax} | ${v.range} | ${pc(v.still)} | ${v.dominant ? `${v.dominant.share}（${v.dominant.hz}）` : '—'} |`);
    }
    p();
  }
  if (r.touch) {
    p('| 触摸部位 | 屏幕坐标 | 反应槽位 → 片段 [遮罩] | 反应出现（s） | 反应层消失（s） | 回 idle（s） |');
    p('|---|---|---|---|---|---|');
    for (const o of r.touch) p(`| ${o.zone} | ${o.at ? o.at.join(',') : '—'} | ${o.reaction ? `${o.reaction.slot} → ${o.reaction.id || '（无片段）'} [${o.reaction.mask}]` : '无反应'} | ${f(o.reactS)} | ${f(o.reactionEndS)} | ${f(o.backToIdleS)} |`);
    p();
  }
  if (r.drag) p(`- 拖拽：${f(r.drag.liftS)} s 后进入拎起（${r.drag.lifted}），悬空时膝盖 ${JSON.stringify(r.drag.kneesUp)}°；松手 → ${r.drag.drop ? `${r.drag.drop.slot} → ${r.drag.drop.id}` : '无反应'}，${f(r.drag.backToIdleS)} s 后回 idle`);
  if (r.talk) p(`- 说话：${r.talk.overlays}；说话片段 ${r.talk.talkClips.join(', ')}；说完 ${f(r.talk.backToIdleS)} s 回 idle`);
  if (r.dance) p(`- 舞蹈：${r.dance.id}（${r.dance.name}），${r.dance.how} 打断，${f(r.dance.backToIdleS)} s 后回 idle（无舞蹈层），跳舞时膝盖最小 ${r.dance.kneesMin}°`);
  if (r.rest) p(`- 姿势休息：${r.rest.seen ? `再等 ${r.rest.afterS} s 后 ${r.rest.pose}（${r.rest.layers}），${r.rest.upAfterS} s 后起身` : `等了 ${r.rest.waitedS} s 未出现${r.rest.rootHips ? '（hips 在地面，只载入站姿，设计如此）' : ''}`}`);
  if (r.jump) {
    p(`- 跳变计：${r.jump.transitions} 次切换，尖峰最大 ${r.jump.spikeMax}°/帧@30fps（躯干 ${r.jump.bodySpikeMax}°），阈值 ${S.spikeMax}；平稳播放 p99 速度 ${r.jump.steadyP99}°/帧`);
    p();
    p('| 切换类型 | 次数 | 尖峰最大 ° | 窗口内速度最大 ° | 最大那次 |');
    p('|---|---|---|---|---|');
    for (const [k, e] of Object.entries(r.jump.byKind)) p(`| ${k} | ${e.n} | ${e.spikeMax} | ${e.speedMax} | ${e.worst} |`);
    p();
  }
  if (r.baseline && Object.keys(r.baseline).length) {
    p('| 对比（同一套指标） | 采样 | 命中率 | 不同片段 | 运动骨骼 | 平均角速度 °/s | 9 骨转幅和 ° | 主频占比中位 | 上臂角速度 °/s | 头角速度 °/s |');
    p('|---|---|---|---|---|---|---|---|---|---|');
    for (const [mode, b] of Object.entries(r.baseline)) p(`| 修复前 ${mode === 'none' ? '用户机器（无库，T-5079 none）' : '旧 22 片段库（T-5079 env）'} 30 s | ${b.samples} | ${pc(b.hitRatio)} | ${b.distinctClips} | ${b.movingBones}/18 | ${b.meanSpeedAll} | ${b.key9RangeSum} | ${b.dominantShareMedian} | ${b.upperArmSpeed} | ${b.headSpeed} |`);
    if (r.idle) p(`| 修复后 ${S.idleSeconds} s | ${r.idle.samples} | ${pc(r.idle.hitRatio)} | ${r.idle.distinctClips} | ${r.idle.movingBones}/18 | ${r.idle.meanSpeedAll} | ${r.idle.key9RangeSum} | ${r.idle.dominantShareMedian} | ${r.idle.boneStats.leftUpperArm && r.idle.boneStats.leftUpperArm.speedMean} | ${r.idle.boneStats.head && r.idle.boneStats.head.speedMean} |`);
    p();
  }
  p(`- 判定：${r.passed ? '通过' : `**失败**：${r.failures.join('；')}`}`);
  p();
}
process.stdout.write(`${out.join('\n')}\n`);
