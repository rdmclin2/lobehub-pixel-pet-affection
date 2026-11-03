// (1) audit coverage: every admin route at the audit baseline vs 01-issues §2 coverage matrix
// (2) plan↔code: every route/label in 02-plan §1.2「优化后」tree vs HEAD ConsoleApp switch + settings-schema RAIL/NAV
const fs=require('fs'),cp=require('child_process');
const sh=c=>cp.execSync(c,{encoding:'utf8'});
const BASE='00252f9';
const routesOf=src=>[...src.matchAll(/case '([a-z]+)':/g)].map(m=>m[1]);
const baseRoutes=routesOf(sh(`git show ${BASE}:admin/src/console/ConsoleApp.tsx`));
const headRoutes=routesOf(fs.readFileSync('admin/src/console/ConsoleApp.tsx','utf8'));
const issues=fs.readFileSync('docs/admin-audit/01-issues.md','utf8');
const matrix=issues.slice(issues.indexOf('## 2. 覆盖矩阵'),issues.indexOf('## 3. 问题清单'));
const rows=matrix.split('\n').filter(l=>l.startsWith('| ')&&!l.includes('---')&&!l.startsWith('| 页面'));
console.log(`[1] baseline ${BASE} admin routes (${baseRoutes.length}): ${baseRoutes.join(' ')}`);
let covered=0;
for(const r of baseRoutes){const row=rows.find(l=>l.includes(`#/${r}`));const ids=row?(row.split('|')[5]||'').trim():'';
 const n=row?[...issues.matchAll(new RegExp(`^#### (${ids.split(/[～、，]/)[0].replace(/-\d+$/,'')}-\\d+)`,'gm'))].length:0;
 if(row)covered++;console.log(`  #/${r.padEnd(11)} ${row?'COVERED':'MISSING'}  module=${row?row.split('|')[1].trim():'-'}  issues=${ids||'-'}`);}
const issueCount=(issues.match(/^#### [A-Z]+-\d+ · /gm)||[]).length;
const modules=rows.map(l=>l.split('|')[1].trim());
const perModule=modules.map(m=>{const ids=rows.find(l=>l.split('|')[1].trim()===m).split('|')[5].trim();const pre=ids.split('-')[0];return `${m}:${(issues.match(new RegExp(`^#### ${pre}-\\d+ · `,'gm'))||[]).length}`});
console.log(`  route coverage ${covered}/${baseRoutes.length} = ${(100*covered/baseRoutes.length).toFixed(0)}%; modules in matrix=${modules.length}; issues=${issueCount}`);
console.log(`  issues per module: ${perModule.join(' · ')}`);
const s=require(process.cwd()+'/src/core/settings-schema.js');
const plan=fs.readFileSync('docs/admin-audit/02-plan.md','utf8');
const after=plan.slice(plan.indexOf('**优化后**'),plan.indexOf('### 1.3'));
const planRoutes=[...new Set([...after.matchAll(/#\/([a-z]+)/g)].map(m=>m[1]))];
console.log(`\n[2] 02-plan §1.2 优化后 routes (${planRoutes.length}): ${planRoutes.join(' ')}`);
const redirects=Object.keys(s.REDIRECTS);
let ok=0;for(const r of planRoutes){const inSwitch=headRoutes.includes(r),inRedir=redirects.includes(r);if(inSwitch||inRedir)ok++;console.log(`  #/${r.padEnd(11)} ${inSwitch?'route in ConsoleApp':inRedir?`redirect → #/${s.REDIRECTS[r]}`:'NOT IN CODE'}`);}
console.log(`  plan routes implemented: ${ok}/${planRoutes.length}`);
console.log(`\n  HEAD RAIL: ${s.RAIL.map(x=>`${x.label}#/${x.page}[${x.group}]`).join(' | ')}`);
const railPlan=['小屋','角色','聊天','商店','玩法','设置'];
console.log(`  RAIL order matches plan §1.1 (${railPlan.join('/')}, divider before 玩法): ${JSON.stringify(s.RAIL.map(x=>x.label))===JSON.stringify(railPlan)&&s.RAIL[4].group!==s.RAIL[3].group}`);
let lbl=0,tot=0;for(const g of s.NAV){for(const it of g.items){tot++;const hit=after.includes(it.label);if(hit)lbl++;console.log(`  NAV ${g.section}/${g.label} → ${it.label} #/${it.page}: ${hit?'named in plan':'NOT NAMED IN PLAN'}`)}}
console.log(`  NAV item labels found in plan tree: ${lbl}/${tot}`);
