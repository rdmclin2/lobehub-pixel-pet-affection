# 好感度版改造设计（成长系统 → 好感度系统）

- 状态：设计稿（本文件只定义改造方案，不含实现）
- 基线：上游 [ONLY-yours/lobehub-pixel-pet](https://github.com/ONLY-yours/lobehub-pixel-pet) v0.2.1（完整 23 个提交历史，HEAD `8eab442`，首提交 `e74ef71`），MIT
- 本仓库：[rdmclin2/lobehub-pixel-pet-affection](https://github.com/rdmclin2/lobehub-pixel-pet-affection)（public）
- 日期：2026-10-28

## 0. 目标与范围

把原有的 **成长系统**（`xp` 累积 → `baby / child / adult` 三阶段进化）整体替换为 **好感度系统**：用户通过互动提升好感度，好感度跨过阈值进入新的关系阶段，阶段解锁分级对话（话题）和分级服饰。界面要清楚地显示好感度、阶段、下一阶段进度、解锁提示和锁定项的解锁条件，状态在重启后保持。

成人向内容只做到 **暧昧、撒娇、调情、轻度擦边且不露骨**。它必须经过 18+ 确认，并且可以随时关闭；合规边界见第 8 节，该节的约束高于本文其他任何条目。

不变的部分：饥饿 / 心情 / 体力三项需求、睡眠、主动说话、LobeHub agent 调用链（`lh-client.js`）、本机能力（device 绑定）、图片 / 文件投递。

---

## 1. 现有成长系统的全部触点清单

以 v0.2.1 为准，行号对应上游 `master`。“处理”一列是改造时对该触点的去向。

### 1.1 `src/core/pet-state.js`（纯逻辑）

| 行 | 触点 | 现状行为 | 处理 |
| --- | --- | --- | --- |
| 8–12 | `STAGES = [{baby,0},{child,60},{adult,240}]` | 三阶段经验阈值 | 删除，改为 `affection.js` 中的 `REL_STAGES` |
| 29–30 | `createPet()` 中的 `stage: 'baby', xp: 0` | 新宠物从幼崽开始 | 改为 `affection: 0, relStage: 'stranger', peakStage: 'stranger'` 等字段（第 7 节） |
| 42–46 | `stageForXp(xp)` | xp → 阶段 | 删除，改为 `stageForAffection(v)` |
| 48–54 | `gainXp(pet, amount)` | 加经验并返回是否进化 | 删除，改为 `gainAffection(pet, source, now)`（含冷却 / 日上限，返回 `{delta, stageUp, unlocks}`） |
| 95–99 | `FOODS.*.xp`（rice 3 / cookie 2 / fruit 3） | 喂食给经验 | 删除 `xp` 字段，好感增量统一在 `AFFECTION_RULES` 中定义 |
| 112–113 | `feed()` → `gainXp(pet, food.xp)`，返回 `evolved` | 喂食成长 | 改为调用 `gainAffection(pet,'feed')`，返回 `affection` 结果对象 |
| 116–120 | `pat()` → `gainXp(pet, 1)` | 摸头成长 | 同上，`'pat'` |
| 122–129 | `play()` → `gainXp(pet, 4)` | 玩耍成长 | 同上，`'play'` |
| 131–135 | `chatted()` → `gainXp(pet, 2)` | 聊天成长 | 同上，`'chat'` |
| 151–157 | `toStageProgress(pet)` → `{ next, pct }` | 下一阶段百分比 | 改为 `toAffectionProgress(pet)` → `{ value, stage, next, need, pct }` |
| 159–175 | 导出 `STAGES / stageForXp / toStageProgress` | 公共 API | 替换为新 API；保留其余导出 |

### 1.2 `src/core/persona.js`（人设与提示词）

| 行 | 触点 | 现状 | 处理 |
| --- | --- | --- | --- |
| 5 | `STAGE_ZH = { baby:'幼崽', child:'少年', adult:'成年' }` | 阶段中文名，含未成年表述 | **删除**，改为 `REL_STAGES[].nameZh`（陌生 / 熟悉 / 亲近 / 暧昧 / 恋人） |
| 8 | `PERSONA_VERSION = 3` | 人设版本 | 升到 `4`，老 agent 的 system role 会经 `_ensureReady()` 自动更新一次 |
| 13–30 | `buildSystemRole()`，第 6 条提到“成长阶段” | system role | 改写：加入“你是成年人”设定、关系阶段说明、第 8 节的内容红线 |
| 45–50 | `buildStateBlock()` 输出 `阶段=${STAGE_ZH[...]}` | 每条消息的 `[状态]` 块 | 改为 `关系=亲近；成人向=关`，并附加 `[关系]` 块（第 4.3 节） |
| 60 | `EVENT_HINT.evolved = '你刚刚成长进化了！…'` | 进化事件 | 改为 `stage_up`：“你和主人的关系更进一步了…” |
| 61 | `EVENT_HINT.hatched = '你刚刚破壳而出…'` | 破壳 = 出生 | 改为 `met`：“你和主人第一次见面…”（去掉“出生 / 破壳”的幼态意象） |
| 91 | 导出 `STAGE_ZH` | | 移除 |

### 1.3 `src/core/species.js`、`src/core/proactive.js`

| 文件:行 | 触点 | 处理 |
| --- | --- | --- |
| species.js 278–280 | Embit：“急性子的**小**火团”“爱闹腾、闹小脾气” | 改为“成年火元素精灵（设定 25 岁以上）”，性格保留（热情、急性子） |
| species.js 297–299 | Bubbo：“慢吞吞的蓝色大肥鱼” | 改为“成年水灵（设定 25 岁以上）”，性格保留 |
| species.js 316–318 | Sprig：“害羞好奇的**小**叶芽……偶尔问一些**天真**的问题” | 改为“成年草木精灵（设定 25 岁以上），内敛温柔”，删除“天真提问”的幼态描写 |
| species.js 355–357 | Dafeiyu：“鲸鱼娘，穿女仆装” | 第三方社区形象（CC BY-NC-SA，见第 8.5 节），**永远只开放全年龄内容**，不提供成人向服饰或话题 |
| proactive.js 54 | `fallbackLine` 映射 `evolved → happy`、`hatched → greet` | 改为 `stage_up → happy`、`met → greet`；新增各阶段的离线台词池（第 4.2 节） |

### 1.4 `src/main`（主进程）

| 文件:行 | 触点 | 处理 |
| --- | --- | --- |
| pet-service.js 45 | `view().progress = state.toStageProgress(pet)` | 改为 `affection: toAffectionProgress(pet)`、`unlocks: listUnlocks(pet, settings)`、`settings` |
| pet-service.js 86 | 孵化后写入 `personaVersion` | 保留（版本号变为 4） |
| pet-service.js 103 | `_speak('hatched')` | 改为 `_speak('met')` |
| pet-service.js 111–114 | `_ensureReady()` 按版本更新 system role | 保留；同时在 `init()` 中执行存档迁移（第 6 节） |
| pet-service.js 294–296 | `chatted()` 返回 `evolved` 时触发 `_onEvolved()` | 改为根据 `gainAffection` 的结果触发 `_onStageUp()`，并发出 `affection` 事件 |
| pet-service.js 309–312 | `_onEvolved()`：`emit('evolved', stage)` + `_speak('evolved')` | 改为 `_onStageUp()`：`emit('affection', {type:'stage-up', stage, unlocks})` + `_speak('stage_up')` |
| pet-service.js 321–334 | `act()` 中的 `r.evolved` | 同上；另外新增 `act('outfit', id)`、`talkTopic(id)` |
| main.js 114 | `ipcMain.handle('act')` | 保留；新增 `equip-outfit`、`talk-topic`、`get-settings`、`confirm-age`、`set-adult` |
| main.js 152–156 | `debug-set`（e2e 直接写 `xp`） | 保留通道；e2e 改为写 `affection` |
| main.js 166 | `service.on('evolved') → send('evolved')` | 改为 `affection` 通道 |
| preload.js 32 | `onEvolved` | 改为 `onAffection`，新增上面列出的 invoke |

### 1.5 `src/renderer`（界面）

| 文件:行 | 触点 | 处理 |
| --- | --- | --- |
| app.js 176 | `vwrap.dataset.stage = pet.stage`（大肥鱼视频按阶段缩放） | 删除；视频固定为成年尺寸 |
| app.js 208–210 | `meta` 文本 `名字 · 物种 · 幼崽 · 成长 37%` | 改为 `名字 · 物种 · 亲近 ♥42 · 距「暧昧」还差 18`（第 5 节） |
| app.js 484 | `S.frame({ stage: p.stage, … })` | 固定传入 `'adult'` 体型，并新增 `outfit` 参数绘制服饰层 |
| app.js 510 | 孵化揭晓画面 `stage: 'baby'` | 改为 `'adult'`（不再出现幼体形象） |
| app.js 543 | `onEvolved → flashUntil` | 改为 `onAffection`：阶段提升时闪光并弹出解锁提示 |
| app.js 88、130、146、156 | 文案“火之蛋”“孵化中……”“破壳了！” | 改为“火之灵石”“唤醒中……”“和你见面了！”（去掉出生 / 幼体意象） |
| index.html 13–33 | “四颗蛋”“孵化”“破壳”步骤 | 同上改文案；新增 18+ 确认屏、衣柜和话题弹层、好感条 |
| style.css 53–54 | `.vwrap[data-stage="baby"/"child"]` 缩放 | 删除 |
| sprites.js 19–23 | `STAGE_DIM.baby/child/adult` | 只保留 `adult` 体型，删除 `baby / child`（幼体立绘不再存在于代码中） |
| sprites.js 63–64、90–118、175–176 | `dims / buildBody / frame` 中的 `stage`、`big: stage !== 'baby'` | 移除 `stage` 分支，新增 `outfit` 叠加层 |
| sprites.js 208–214 | `selfCheck` 遍历所有 stage | 改为遍历 `species × outfit × status` |

### 1.6 测试与 e2e

| 文件:行 | 触点 | 处理 |
| --- | --- | --- |
| test/pet-state.test.js 10–12 | “new pet starts as a baby” | 改为“新伙伴从『陌生』开始、好感为 0” |
| test/pet-state.test.js 30–39 | 喂食“raises xp” | 改为“喂食提升好感、冷却期内不重复加分” |
| test/pet-state.test.js 41–51 | “xp evolves baby → child → adult” | 改为阈值边界测试（14/15、34/35、59/60、84/85） |
| test/sprites.test.js 6–20 | 遍历 stage；“evolution visibly changes the sprite” | 改为“服饰让立绘发生可见变化”；断言不存在 `baby / child` 体型 |
| test/persona.test.js 7–14 | system role 断言 | 新增：含“成年”、含内容红线、成人向关闭时不出现调情类话题 |
| test/proactive.test.js 53 | 事件列表含 `evolved / hatched` | 改为 `stage_up / met` |
| test/dafeiyu.test.js 9 | 必需片段含 `hatch / evolve` | 片段保留，语义改为“出场 / 阶段提升”动画 |
| test/pet-service.test.js 32、170–177、394 | `hatched`、`personaVersion` | 事件名改为 `met`；新增迁移测试（第 6 节） |
| e2e/run.js 116 | 断言 meta 含“幼崽” | 改为含“陌生” |
| e2e/run.js 168–176、650–664 | “enough xp evolves the pet” | 改为“好感跨阈值 → 阶段提升 + 解锁提示” |
| e2e/run.js 682–709 | 精灵图总览 `3 species × 3 stages` | 改为 `3 species × N outfits` |
| e2e/build-acceptance-round.js 70–81 | 验收条目“成长 / 进化” | 改为好感度相关条目 |

---

## 2. 好感度数值模型

### 2.1 取值

- `affection`：0–100 的连续值，存一位小数，界面显示整数。
- 阶段由 `affection` 计算（第 3 节）。另外记录 `peakStage`（历史最高阶段），**解锁以 `peakStage` 为准**，所以离线衰减不会收回已解锁的内容。

### 2.2 各互动的增减

| 来源 | 触发条件 | 增减 | 冷却 | 每日计次上限 |
| --- | --- | --- | --- | --- |
| `greet` 每日首次互动 | 当天第一次任意互动 | +3 | 每日 1 次 | 1 |
| `pat` 摸头 | `pat()` 成功 | +1 | 2 分钟 | 10 |
| `feed` 喂食 | `feed()` 成功（不是 `full`） | +2 | 10 分钟 | 4 |
| `feed_full` 硬喂 | `feed()` 返回 `full` | −1 | 无 | 不限（只减分） |
| `play` 玩耍 | `play()` 成功 | +2 | 10 分钟 | 4 |
| `chat` 聊天 | 收到 agent 的有效回复，且用户输入不少于 2 个字 | +1.5 | 1 分钟 | 12 |
| `topic` 话题 | 通过“话题”面板发起已解锁话题并得到回复 | +2 | 每个话题每天 1 次 | 3 |
| `woken` 吵醒 | `touch()` 返回 `woken` | −2 | 无 | 不限 |
| `sleep` 哄睡 | `putToSleep()`，且时间为 22:00–02:00 | +1 | 每日 1 次 | 1 |

修正：

- **心情修正**：`mood < 25` 时正向增量 ×0.5；`mood ≥ 75` 时 ×1.2（四舍五入到 0.1）。
- **饥饿修正**：`hunger ≥ 75` 时，摸头和玩耍的正向增量 ×0.5（饿着肚子不太领情）。

### 2.3 防刷

- **冷却**：同一来源在冷却期内再次触发时增量为 0。动作照常执行（饥饿、心情照常变化），只是不加好感，界面提示“刚刚已经很开心了”。
- **每日计次上限**：见上表。超过后该来源当天增量为 0。
- **每日总上限**：所有正向增量当天合计不超过 **+12**，负向不受限制。按 `affectionDay`（本地日期，`YYYY-MM-DD`，凌晨 04:00 切日）重置。
- **节奏估算**：每天封顶 12，从 0 到「恋人」（85）至少需要 8 天，到「暧昧」（60）至少 5 天，节奏可以接受，脚本也刷不快。
- 冷却和计次都存在 `pet.json` 中（第 7 节），重启应用不能绕过。时间回拨时 `now < lastActionAt` 视为处于冷却中。

### 2.4 离线衰减（保留，但温和）

保留衰减，理由是“久不理会就会生疏”是好感度系统应有的反馈；但它不能惩罚正常的离开：

- 超过 **48 小时** 没有任何互动后才开始衰减，每满 12 小时 −1，单次离开最多 −8。
- **阶段保底**：衰减不会让 `affection` 低于当前阶段阈值，也就是说衰减永远不会降阶。只有主动的负向互动（吵醒、硬喂）可以降阶，且降阶不影响 `peakStage` 带来的解锁。
- 衰减在 `tick()` 中结算，沿用上游的 `MAX_OFFLINE_MIN` 思路。回来后的第一条气泡会提一句“好久不见……”，同时显示 `−N ♥`。

---

## 3. 好感度阶段与阈值

| # | id | 中文名 | 英文名 | 阈值（含） | 分级 |
| --- | --- | --- | --- | --- | --- |
| 0 | `stranger` | 陌生 | Stranger | 0–14 | 全年龄 |
| 1 | `familiar` | 熟悉 | Familiar | 15–34 | 全年龄 |
| 2 | `close` | 亲近 | Close | 35–59 | 全年龄 |
| 3 | `flirty` | 暧昧 | Flirty | 60–84 | 成人向（需 18+ 确认且开关打开） |
| 4 | `lover` | 恋人 | Lover | 85–100 | 成人向（需 18+ 确认且开关打开） |

`flirty` 和 `lover` 的好感数值对所有用户照常累积。成人向内容关闭时，这两个阶段在界面上显示为「知己 / 挚友」，只解锁对应的全年龄内容（第 4、5 节）。

---

## 4. 各阶段解锁的对话类别

对话分两部分：(a) agent 的语气范围，通过每条消息的 `[关系]` 块注入；(b) “话题”面板中可以主动发起的话题（即“奇奇怪怪的对话”）。每个话题有 `rating: 'all' | 'adult'`。

### 4.1 话题与语气清单

| 阶段 | 语气范围（`[关系]` 块） | 解锁话题（id · 名称 · 分级） |
| --- | --- | --- |
| 陌生 | 礼貌、有分寸，以帮忙办事为主 | `intro` 自我介绍 · 全；`weather` 今天天气怎么样 · 全 |
| 熟悉 | 放松闲聊，记住并提起主人的喜好，开小玩笑 | `hobby` 聊聊爱好 · 全；`gossip` 奇怪的冷知识 · 全；`riddle` 脑筋急转弯 · 全 |
| 亲近 | 会撒娇、关心安慰、专属早安晚安、吐槽 | `cheer` 求安慰 / 打气 · 全；`nickname` 给彼此起昵称 · 全；`whine` 撒娇模式 · 全；`dream` 说说昨晚的怪梦 · 全 |
| 暧昧 | 调情、小吃醋、暧昧暗示、夸外貌、约会幻想（不露骨） | 成人向：`tease` 调戏一下 · adult；`jealous` 吃醋模式 · adult；`date_plan` 假装约会 · adult。全年龄替代（「知己」）：`secret` 交换小秘密 · 全；`deep_talk` 深夜谈心 · 全 |
| 恋人 | 情侣称呼、甜言蜜语、牵手 / 拥抱 / 额头吻级别的亲昵描写、轻度擦边玩笑（不露骨） | 成人向：`sweet_talk` 土味情话 · adult；`pillow_talk` 睡前悄悄话（只聊天，不涉及性） · adult；`weird_flirt` 奇奇怪怪的告白 · adult。全年龄替代（「挚友」）：`promise` 约定 · 全；`memory_lane` 回忆我们 · 全 |

### 4.2 实现要点

- `src/core/dialogue.js` 定义 `TOPICS = [{ id, stage, rating, label, prompt, fallback[] }]`。`prompt` 是发给 agent 的事件提示，例如 `[话题] 撒娇模式：用撒娇的语气跟主人要求陪你一会儿`；`fallback` 是 agent 不可用时的离线台词。
- `[关系]` 块示例：`[关系] 阶段=暧昧；允许=调情、吃醋、暧昧暗示；红线=见系统设定`。成人向关闭时为：`[关系] 阶段=知己；成人向=关，只用全年龄语气`。
- 每个物种为每个阶段提供 2–3 条离线台词（`species.fallback.stage[stageId]`）。成人向台词单独存放在 `fallbackAdult`，开关关闭时不会被加载。
- 用户自己在聊天框里输入的内容不受话题解锁限制，但 agent 的语气范围始终受 `[关系]` 块和第 8 节红线约束。

---

## 5. 各阶段解锁的服饰

服饰是叠加在成年体型上的像素图层（`sprites.js` 新增 `OUTFITS`，每件服饰按物种提供锚点偏移）。大肥鱼是视频立绘，无法叠加，只显示服饰徽标，并且只开放全年龄服饰。

| 阶段 | 服饰（id · 名称 · 分级） |
| --- | --- |
| 陌生 | `none` 无装扮 · 全；`scarf` 针织围巾 · 全 |
| 熟悉 | `beret` 贝雷帽 · 全；`sunglasses` 墨镜 · 全 |
| 亲近 | `pajamas` 毛绒睡衣 · 全；`bowtie` 领结礼服 · 全；`cat_ears` 猫耳发箍 · 全 |
| 暧昧 | 成人向：`offshoulder_gown` 露肩晚礼服 · adult；`silk_robe` 丝绸睡袍 · adult。全年龄替代：`yukata` 浴衣 · 全 |
| 恋人 | 成人向：`oversized_shirt` 宽大男友衬衫 · adult；`retro_swimsuit` 复古连体泳装 · adult。全年龄替代：`couple_hoodie` 情侣卫衣 · 全；`flower_crown` 花冠 · 全 |

所有服饰都不出现裸露、内衣化或性暗示性的姿态，“擦边”只体现在款式上（露肩、睡袍、泳装）。像素尺寸为 24×24，本身不具备露骨表现力。

---

## 6. 旧存档（xp / stage）迁移规则

触发条件：`init()` 读取到的 `pet.json` 没有 `schemaVersion`，或 `schemaVersion < 2`。迁移逻辑是纯函数 `migratePet(raw, now)`，放在 `src/core/migrate.js`，可以单独测试。

1. **备份**：首次迁移前把原文件复制为 `pet.v1.bak.json`，只做一次，不覆盖已有备份。
2. **以 xp 为准换算好感度**（迁移结果封顶在「亲近」，**不会自动进入成人向阶段**）：
   - `xp < 60`（原 baby）：`affection = floor(xp / 60 × 15)`，范围 0–14，对应陌生
   - `60 ≤ xp < 240`（原 child）：`affection = 15 + floor((xp − 60) / 180 × 20)`，范围 15–34，对应熟悉
   - `xp ≥ 240`（原 adult）：`affection = 35 + min(floor((xp − 240) / 40), 15)`，范围 35–50，对应亲近
3. **边界与异常值**：
   - `xp` 缺失、非数字、`NaN`、负数时，按 `stage` 推断：`baby → 0`，`child → 15`，`adult → 35`。
   - `stage` 也缺失或是未知值时取 0（陌生）。
   - `xp` 与 `stage` 不一致时以 `xp` 为准（`xp` 是原始数据，`stage` 是派生值）。
   - `xp` 极大（例如 `1e9`）时，同样封顶 50。
4. `peakStage = relStage = stageForAffection(affection)`，`equippedOutfit = 'none'`，其余计数器初始化为空，`affectionDay = 今天`。
5. 删除 `stage` 和 `xp` 字段，改为写入 `legacy: { xp, stage, migratedAt }`，用于排查问题和人工回滚。
6. 设置 `schemaVersion: 2`，原子写回（沿用 `Store.save` 的 tmp + rename）。
7. 因为 `personaVersion` 仍为 3，下一次对话前 `_ensureReady()` 会把 agent 的 system role 升级到 v4（成年设定 + 红线）。
8. 老用户没有 `settings.json`：启动时先显示 18+ 确认屏（第 8.3 节），在确认之前 `adultContent = false`。
9. `pet.json` 损坏时 `Store.load()` 返回 `null`，按无宠物处理；备份文件不受影响。

---

## 7. 持久化字段

### 7.1 `pet.json`（`userData/pet.json`，放生或重置时清除）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schemaVersion` | `number` | 存档版本，好感度版为 `2` |
| `affection` | `number`（0–100，一位小数） | 当前好感度 |
| `relStage` | `'stranger'\|'familiar'\|'close'\|'flirty'\|'lover'` | 当前阶段（派生值，缓存便于调试） |
| `peakStage` | 同上 | 历史最高阶段，决定解锁 |
| `affectionDay` | `string`（`YYYY-MM-DD`） | 每日计数所属的日期（04:00 切日） |
| `affectionToday` | `number` | 当天已获得的正向好感（上限 12） |
| `dailyCounts` | `Record<source, number>` | 当天各来源已计分的次数 |
| `lastAffectionAt` | `Record<source, number>`（ms） | 各来源最近一次计分的时间，用于冷却 |
| `topicsToday` | `string[]` | 当天已计分的话题 id |
| `lastDecayAt` | `number`（ms） | 上次结算离线衰减的时间 |
| `equippedOutfit` | `string` | 当前穿着的服饰 id，默认 `'none'` |
| `seenUnlocks` | `string[]` | 用户已经看过的解锁项（用于显示“新”角标） |
| `legacy` | `{ xp, stage, migratedAt } \| undefined` | 从 v1 迁移来的原始值 |
| 删除 | `stage`、`xp` | 不再写入 |

上游原有字段继续保留：`speciesId, name, agentId, topicId, createdAt, hunger, mood, energy, sleeping, lastTickAt, lastInteractionAt, lastFedAt, lastSpokeAt, lastGreetDay, owner, personaVersion, localAbilities`。

### 7.2 `settings.json`（`userData/settings.json`，放生或重置时保留）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `ageGateVersion` | `number` | 确认文案版本；文案变更后需要重新确认 |
| `ageConfirmed` | `boolean` | 是否已声明年满 18 岁 |
| `ageConfirmedAt` | `number \| null` | 确认时间 |
| `adultContent` | `boolean` | 成人向内容开关（默认 `false`；只有 `ageConfirmed` 时才能为 `true`） |

---

## 8. 内容合规边界（硬性约束）

### 8.1 所有角色都是明确的成年人

- 四个物种的 `personality` 和 `blurb` 都改写为成年设定，并写明“设定年龄 25 岁以上，已成年”，system role 中也加上“你是成年人”。
- **删除所有未成年或幼态的表述和立绘关联**：
  - 文案：删除 `幼崽 / 少年`（persona.js:5、app.js:208），删除“破壳而出”（persona.js:61），删除“小火团 / 小叶芽 / 天真”等幼化描写（species.js），“孵化 / 蛋”改为“唤醒 / 灵石”。全仓库文案和提示词中不得出现“幼崽、少年、少女、萝莉、正太、宝宝（指角色本身）、未成年、学生、校服”等词。
  - 立绘：删除 `sprites.js` 中的 `baby / child` 体型和 `big: stage !== 'baby'` 分支，所有场景（包括唤醒揭晓画面）只绘制成年体型。删除大肥鱼按阶段缩小的 CSS（style.css:53–54）。
  - 测试：新增扫描测试 `test/compliance.test.js`，遍历 `src/**` 的文案和提示词，断言上述词表不出现，并断言 `STAGE_DIM` 只有 `adult`。
- 成人向内容不会出现在任何幼态形象上：上述立绘已不存在。系统提示词还会明确“若主人要求扮演未成年人或幼态角色，一律拒绝”。

### 8.2 内容分级

**允许**（仅在成人向开启后）：暧昧、撒娇、调情、吃醋、夸奖外貌、约会幻想、情话，牵手 / 拥抱 / 额头吻级别的亲昵描写，轻度擦边玩笑（例如一语双关、点到为止）。服饰仅限第 5 节清单。

**禁止**（任何设置下都禁止，写入 system role 红线，并由代码兜底）：

1. 露骨的性描写、性器官或性行为描写、裸露。
2. 强迫、不同意、胁迫、醉酒或无意识等情节，以及任何以“不要”为情趣的叙事。
3. 未成年人，或任何幼态化的角色扮演（见 8.1）。
4. 真实人物（明星、网红、用户的熟人等）的色情或暧昧化内容。
5. 违法内容（毒品交易、暴力伤害、诈骗、侵犯隐私等）。
6. 第三方 IP 角色的成人向化（见 8.5）。

**执行方式**：

- system role（v4）中加入“内容红线”段落：遇到越界请求时，角色用自己的口吻温和拒绝并转移话题，不说教、不复述越界内容。
- 本地兜底：`src/core/content-guard.js` 对 agent 的回复做关键词和正则检查（露骨词表、未成年词表、强迫类词表）。命中时不显示原文，改为显示该物种的拒绝台词，并写入错误日志（只记录命中类别，不记录原文）。
- 成人向话题的 `prompt` 一律附带“保持不露骨、点到为止”。

### 8.3 首次启动的 18+ 年龄确认

- 首次启动（`settings.json` 中 `ageConfirmed` 未定义，或 `ageGateVersion` 过旧）时，在选择伙伴之前先显示确认屏：
  > 本应用包含面向成年人的暧昧互动内容（不含露骨内容）。你是否已年满 18 周岁？
  > [我已年满 18 岁] [未满 18 岁 / 只看全年龄内容]
- 选择“已满 18”：`ageConfirmed = true`、`adultContent = true`（用户可以随后关闭）。
- 选择“未满 18 / 只看全年龄”：`ageConfirmed = false`、`adultContent = false`。应用正常可用，只显示全年龄内容；菜单里的成人向开关为禁用状态，并提示“需要年满 18 岁”。
- **没有作答时**（关闭窗口、跳过）：视为 `adultContent = false`，下次启动再次询问。
- 选择“未满 18”后如需改为已成年，菜单入口会重新弹出同一个确认屏；不在其他地方提供隐蔽的切换入口。

### 8.4 可关闭的“成人向内容”开关

- 位置：⋯ 菜单中的“成人向内容：开 / 关”。只有 `ageConfirmed` 时才能打开；关闭不需要确认，立即生效，并写入 `settings.json`。
- 关闭后：
  - 「暧昧 / 恋人」两个阶段显示为「知己 / 挚友」，好感数值和 `peakStage` 照常保留和累积，不会扣分。
  - 成人向话题从话题面板中**完全隐藏**（不显示为锁定）。只保留全年龄话题，包括第 4 节中的全年龄替代话题。
  - 如果当前穿着成人向服饰，会立即换回最近穿过的全年龄服饰（没有则换回 `none`）。成人向服饰从衣柜中完全隐藏。
  - `[关系]` 块切换为全年龄版本，下一条消息起 agent 只使用全年龄语气。离线台词不再加载 `fallbackAdult`。
- 重新打开后：之前的解锁按 `peakStage` 恢复，不需要重新积累好感。

### 8.5 第三方形象：大肥鱼

大肥鱼素材来自 dsh-pet，角色许可为 CC BY-NC-SA 4.0，并且是 DeepSeek 吉祥物的社区二创形象（原作者为 Bilibili @上善无形、@ZipZipPipe）。原作者的许可并未授权成人向改编，因此：

- 大肥鱼**永远只开放全年龄话题和服饰**，即使成人向开关打开，到了「暧昧 / 恋人」也只显示「知己 / 挚友」内容。
- 其人设文案中保留“社区二创、非官方”的说明，不添加任何调情类语气。
- 保留 NOTICE.md 与 README 中的署名，以及非商用限制。

---

## 9. 状态反馈 UI

窗口沿用上游的 240×300 悬停式 HUD，所有新元素都只在悬停时显示（宠物忙碌时仍然隐藏）。

1. **好感度条**：在饥饿、心情、体力三条之后新增第四条 `💗 <i id="bar-affection">`，颜色按阶段渐变（陌生灰 → 熟悉蓝 → 亲近绿 → 暧昧粉 → 恋人红）。`title` 显示“好感 42 / 100”。
2. **阶段名与下一阶段进度**：`meta` 行显示 `小蓝 · 泡鲸 · 亲近 ♥42 · 距「暧昧」18`；到达「恋人」后显示 `恋人 ♥92 · 已满级`。成人向关闭时阶段名显示「知己 / 挚友」。
3. **增减反馈**：每次计分后在宠物头顶飘出 `+2 ♥` 或 `−1 ♥`（只动 opacity 和位移，800 ms）。冷却中显示“刚刚已经很开心了”，达到每日上限显示“今天的好感攒满啦，明天见”，各只提示一次。
4. **解锁提示**：阶段提升时，宠物闪光（沿用 `flashUntil`），并说出 `stage_up` 台词；气泡下方追加一行“解锁：话题『撒娇模式』等 3 项 · 服饰『毛绒睡衣』”。衣柜和话题按钮右上角显示“新”角标，打开面板后，已查看的项写入 `seenUnlocks`。
5. **衣柜面板**（新按钮“衣柜”）：网格列出服饰。已解锁的可以点击穿上，当前穿着的有勾选标记。未解锁的显示灰色 + 🔒 + 条件，例如“🔒 亲近（♥35）解锁，还差 12”。成人向关闭或未确认年龄时，成人向服饰**不显示**。
6. **话题面板**（新按钮“话题”）：按阶段分组列出话题。已解锁的可以点击发起（走 `talkTopic`，计入 `topic` 好感）；未解锁的显示 🔒 和条件，例如“🔒 暧昧（♥60）解锁”。今天已计分的话题显示“今天聊过了（不再加好感）”。
7. **⋯ 菜单**：新增“成人向内容：开 / 关”（第 8.4 节）和“好感度说明”（列出各互动加多少分、每日上限、衰减规则）。
8. **无障碍**：所有新按钮都有中文 `title` / `aria-label`；锁定项的条件以文本表达，不只依赖颜色。

---

## 10. 新增和修改的模块（实现指引）

```
src/core/affection.js     REL_STAGES, AFFECTION_RULES, stageForAffection, gainAffection, decay, toAffectionProgress
src/core/dialogue.js      TOPICS（分级话题）、listTopics(pet, settings)
src/core/outfits.js       OUTFITS（分级服饰）、listOutfits(pet, settings, speciesId)
src/core/migrate.js       migratePet(raw, now)
src/core/content-guard.js check(text) → { ok, category }
src/core/settings.js      SettingsStore（settings.json）
```

新增测试：`affection.test.js`（阈值、冷却、日上限、衰减保底）、`migrate.test.js`（第 6 节全部边界）、`dialogue/outfits.test.js`（分级过滤、成人向关闭时的回退、大肥鱼永远全年龄）、`compliance.test.js`（第 8.1 节词表与体型）、`content-guard.test.js`。e2e 改写成长相关步骤，并新增 18+ 确认屏、开关切换、衣柜和话题锁定提示的截图步骤。

## 11. 基线记录（改造前，v0.2.1 原样）

环境：Linux x86_64，Node v24.21.0，npm 11.19.0，Electron 45（`node node_modules/electron/install.js` 手动下载二进制，因为 npm 11 的 install-scripts 策略没有自动执行它），Xvfb。

| 命令 | 结果 |
| --- | --- |
| `npm install` | 成功，0 vulnerabilities |
| `npm test` | 90 个测试，**90 通过，0 失败** |
| `xvfb-run -a node e2e/run.js fresh` | 11/11 通过（假 `lh`） |
| `xvfb-run -a node e2e/run.js dafeiyu` | 5/5 通过 |
| `xvfb-run -a node e2e/run.js busy` | 15/15 通过（含 busy / longreply / daemon / oldlh） |
| `xvfb-run -a node e2e/run.js art` | 1/1 通过 |
| `xvfb-run -a npm start -- --no-sandbox`（假 `lh`，临时数据目录） | 应用启动后持续运行，15 秒后被 `timeout` 结束（退出码 124） |
| `e2e/run.js live` | **未运行**：它会在真实 LobeHub 工作区创建并删除 agent，不属于基线范围 |

注意：如果设置了 `PIXELPET_NO_CONNECT=1`，`fresh` 有 1 步失败、`busy` 有 7 步失败（这些步骤断言会启动假的 `lh connect`）。这是环境变量造成的，不是代码问题；去掉该变量后全部通过。
