# LobeHub Pixel Pet · 好感度版（Affection Edition）· 18+

> **⚠️ 成人向（18+）应用。** 本应用包含面向成年人的暧昧互动内容（调情、情话、约会幻想等），**不含露骨内容**。首次启动会询问是否年满 18 周岁；未满 18 岁或选择“只看全年龄”时，所有成人向内容都不会出现。成人向内容可随时在 ⋯ 菜单中关闭。

一位住在桌面上的**模型娘**伙伴：以 AI 模型厂商为主题的同人角色（DeepSeek 大肥鱼、Claude 娘克洛蒂、Grok 娘格萝可、Gemini 娘杰米、GPT 娘吉皮缇，都不是厂商官方形象），大脑是你自己的 [LobeHub](https://lobehub.com) agent。本派生版把上游的“成长系统”改造成**好感度系统**：和它互动（摸摸、喂食、玩耍、聊天、话题）会提升好感度，好感度到达新阶段就会解锁新的对话话题和服饰。

- **好感度反馈**：悬停时显示 💗 好感条、数值（♥42/100）、阶段名和“距「下一阶段」还差 N”；每次加分在宠物头顶飘出 `+N ♥`，冷却或当日上限时会说明原因。
- **升级提示**：跨过阈值时弹出“🎉 关系升级”，逐一列出本次解锁的话题和服饰。
- **话题面板**：按阶段分组，锁定话题显示 🔒 和解锁条件；点已解锁话题，agent 按该话题和当前阶段的语气回应。
- **衣柜**：每位角色只列出她有美术的服饰（现在五位角色都只有各自的原设服装，大肥鱼是招牌女仆装）；衣柜里看到的就是她换上后桌面上的样子，锁定项显示 🔒 和解锁条件，换装立即生效。
- **放在哪里由你选**：唤醒时会问把 agent 建在哪里，默认是**个人空间**；也可以选你加入的某个 workspace（那里的成员可能看得到它）。之后所有调用都固定在这个空间。
- **状态保持**：好感度、阶段、已解锁内容和当前服饰保存在本机 `pet.json`，退出重启后不变；18+ 回答和成人向开关保存在 `settings.json`。

## 模型娘角色

> - **[形象 / 角色清单](docs/characters.md)**：每位模型娘的厂商、形象设定、主题色、服饰、素材来源与许可、截图，以及已下线角色和存档迁移。
> - **[使用说明](docs/usage.md)**：安装、运行（含 Linux chrome-sandbox）、选角与切换、每项效果怎么触发、高级设置、连接 LobeHub、打包、测试，以及新增一个厂商角色。

| 角色 | 厂商 | 主题色 | 美术 | 服饰 |
|---|---|---|---|---|
| 大肥鱼（DeepSeek 娘 · 鲸鱼女仆） | DeepSeek | `#2C4A8A` | 像素包 `dafeiyu-pixel`（默认，和其他角色同一画风和比例）；可在“外观”里换成原版 Q 版 21 段透明视频（dsh-pet，含拖拽、走路和 5 种点击回应） | 招牌女仆装 |
| 克洛蒂（Claude 娘 · 橘发菊纹） | Anthropic | `#C4622D` | 像素包 `claude-pixel`（16 个动作） | 橘白哥特长裙 |
| 格萝可（Grok 娘 · 黑金吸血鬼） | xAI | `#8E1F33` | 像素包 `grok-pixel`（16 个动作） | 黑金哥特礼服 |
| 杰米（Gemini 娘 · 四角星猫耳） | Google | `#7B5CD6` | 像素包 `gemini-pixel`（16 个动作） | 星纹宽袖外披 |
| 吉皮缇（GPT 娘 · 白龙） | OpenAI | `#8E7FC8` | 像素包 `gpt-pixel`（16 个动作） | 白玫瑰立领长裙 |

- 每个角色是一份数据文件 `src/characters/<id>.json`（厂商、人设、口头禅、离线台词、主题色、可用服饰、署名），美术是一个角色包（`src/renderer/packs/<id>-pixel`）或一组视频；**效果全部共用**，角色之间只差配置、素材和台词。新增角色：放一份 character.json 和一个角色包即可，不用改代码。设定与素材来源见 [art/model-chan/](art/model-chan/README.md)。
- 五位都是全年龄角色（`adult: false`）：即使确认 18+ 并开启成人向内容，她们也只用全年龄的语气、话题和服饰。成人向机制仍保留，只对 character.json 里写明 `adult: true` 的角色生效。
- **旧角色已下线**：焰团、泡鲸、叶芽和“灵石”选择界面已移除。老存档打开时自动由新角色接替（泡鲸、叶芽 → 大肥鱼，焰团 → 克洛蒂），LobeHub agent、聊天记录和好感度都保留，她的人设在下一句话前更新；身上的服饰如果新角色没有，就换回日常服。旧存档会备份为 `pet.retired.bak.json`。
- **换角色**：⋯ 菜单 → **切换角色**。每位角色有自己的 LobeHub agent、聊天记录、名字、好感度和饥饿 / 心情 / 精力：第一次见面时点“初次见面”给她起名（默认用她自己的名字），应用为她新建一个 agent；见过的角色点“切换”，回来时一切照旧。不在屏幕上的角色需求值暂停，不会因为你陪了别人而饿坏或掉好感。
- **换模型**：⋯ 菜单 → **切换角色** → 模型。每位角色只能选自家厂商的模型（大肥鱼 DeepSeek、克洛蒂 Claude、格萝可 Grok、杰米 Gemini、吉皮缇 GPT），列表来自你在 LobeHub 里启用的模型；换角色时模型跟着换成新角色的（每位角色各自记住你的选择）。

### 每个角色都有的效果（移植自 dsh-pet）

| # | 效果 | 怎么触发 |
|---|---|---|
| E1 | 唤醒演出（hatch） | 选好角色点“唤醒”，或切换角色 |
| E2 | 待机呼吸 | 平时 |
| E3 | 自播链：东张西望 / 转身（左右镜像）/ 小动作 / 开心，按权重每 12–25 秒随机一次，不连续重复 | 指针不在宠物上时自动 |
| E4 | 点击回应：摸摸 / 开心两种随机交替，带 Q 弹挤压和爱心粒子 | 点一下宠物 |
| E5 | 被拎起（悬空摇晃） | 按住宠物拖动 |
| E6 | 甩出：按松手速度飞出，重力下落，撞屏幕边缘反弹，落在屏幕底部 | 拖动中快速甩开松手 |
| E7 | 吃饭 / 吃零食 / 吃水果（三种不同动画） | 喂食菜单 |
| E8 | 玩耍 | “玩耍” |
| E9 | 睡觉 | “睡觉”或夜里累了 |
| E10 | 饿了 / 难过 / 开心 | 随饥饿、心情变化 |
| E11 | 工作状态：思考中 → 说话；出错时难过；每条消息带时间背景（时段、星期、节日） | 聊天、话题、主动说话 |
| E12 | 关系升级：进化动画、闪光和爱心 | 好感跨过阶段 |
| E13 | 角色专属衣柜 | “衣柜” |
| E14 | 换角色：每位角色各自的 agent、聊天记录、名字和好感度 | ⋯ → 切换角色 |
| E15 | 自己走动：空闲时朝面向的方向走 60–240 像素，到屏幕边掉头（大肥鱼播 dsh-pet 的螃蟹走路，像素角色待机帧颠步） | 自动；高级设置 → 桌宠行为 →“自己走动”可关 |
| E16 | 触屏长按 / 右键打开菜单 | 在宠物身上长按（触屏）或右键 |
| E17 | 动作点播、回到右下角 | ⋯ → 动作… / 回到右下角 |
| E18 | 弹弓：连按两下后拉开再松手，朝反方向弹出，力度只看拉多远 | 300 毫秒内第二次按下并拖动 |
| E19 | 空中接住得分：飞行中点中她，弹出“+N”和火花（越快、越小分越高） | 甩出后点她 |
| E20 | 落地挤压：落得越重压得越扁 | 甩出、弹弓 |
| E21 | 点击音效（默认关） | 高级设置 → 桌宠行为 |
| E22 | 梗图：回复可配一张她自己的表情包贴纸（agent 自选），碎碎念偶尔随机配一张 | 默认开，可关 |
| E23 | 朗读回复：用她自己的音色念出回复（Fish Audio / MiniMax 神经语音，用不了时降级到系统语音），默认关；配置见下方“语音（TTS）” | 高级设置 → 桌宠行为 / 语音 |
| E24 | 同屏伙伴：请其他模型娘来桌面串门（最多 3 位，无 agent），一起走动、被点、被甩 | 高级设置 → 同屏伙伴 |
| E25 | 互相碰撞：甩出去的她把撞到的伙伴弹开（动量守恒） | 有同屏伙伴时甩她 |
| E26 | 本机 HTTP 接口：脚本让她说话、播动作、抛出去、聊一句、读状态（默认关，需令牌） | 高级设置 → 对外接口 |

与 dsh-pet 的逐项对照（已实现 / 本次实现 / 不移植及理由）见 [docs/dsh-pet-gap.md](docs/dsh-pet-gap.md)。

动作和状态的对应、回落规则见 `src/core/fx.js`；角色缺某个状态的素材时按回落链降级（例如“吃水果”→“吃饭”→“开心”→“待机”）并叠加表情符号，所以只有一张待机图的角色包也能跑全部效果。

## 好感度阶段

| 阶段 | 好感度 | 分级 | 成人向关闭时显示为 | agent 允许的语气 |
|---|---|---|---|---|
| 陌生 | 0–14 | 全年龄 | 陌生 | 礼貌、有分寸，以帮忙办事为主 |
| 熟悉 | 15–34 | 全年龄 | 熟悉 | 放松闲聊，记住喜好，开小玩笑 |
| 亲近 | 35–59 | 全年龄 | 亲近 | 撒娇、关心安慰、专属早安晚安 |
| 暧昧 | 60–84 | 成人向 | 知己 | 成人向：调情、小小吃醋、夸好看、约会幻想（不露骨）；全年龄：交心、分享小秘密 |
| 恋人 | 85–100 | 成人向 | 挚友 | 成人向：情侣称呼、甜言蜜语，最多到牵手/拥抱/额头吻；全年龄：默契、约定、回忆往事 |

加分规则：摸摸 +1、喂食 +2、玩耍 +2、聊天 +1.5、话题 +2、每日首次互动 +3、22:00–02:00 哄睡 +1；硬喂 −1、吵醒 −2。每种互动有冷却和每日次数上限，所有来源合计每天最多 +12。离开 48 小时后每 12 小时 −1（每次离开最多 −8，不会掉出当前阶段）。解锁按达到过的最高阶段计算，好感回落不会收回已解锁内容。详见 [docs/affection-design.md](docs/affection-design.md)。

## 各阶段解锁的对话与服饰

| 阶段 | 解锁话题（全年龄） | 解锁话题（成人向） | 解锁服饰（全年龄） | 解锁服饰（成人向） |
|---|---|---|---|---|
| 陌生 ♥0 | 自我介绍、今天天气怎么样 | — | 日常服、针织围巾套装 | — |
| 熟悉 ♥15 | 聊聊爱好、奇怪的冷知识、脑筋急转弯 | — | 休闲卫衣、贝雷帽画家装 | — |
| 亲近 ♥35 | 求安慰 / 打气、给彼此起昵称、撒娇模式、说说昨晚的怪梦 | — | 毛绒睡衣、猫耳家居服 | — |
| 暧昧（知己）♥60 | 交换小秘密、深夜谈心 | 调戏一下、吃醋模式、假装约会 | 浴衣 | 女仆装（长袖及膝）、露肩晚礼服（及地） |
| 恋人（挚友）♥85 | 约定、回忆我们 | 土味情话、睡前悄悄话、奇奇怪怪的告白 | 情侣卫衣、花冠长裙 | 复古连体泳装（保守款）、丝绸睡袍（及膝、系好腰带） |

合计 19 个话题（13 全年龄 + 6 成人向）、13 套服饰（9 全年龄 + 4 成人向；目前每位角色只有原设服装有美术，其余服饰不显示）。每个阶段除话题外还有对应的离线台词（问候、被喂、被摸、玩耍、无聊、升级）。成人向关闭时，成人向话题、服饰和台词**完全隐藏**（不显示为锁定），身上的成人向服饰会自动换回最近穿过的全年龄服饰；重新开启后按已达到的阶段恢复，不需要重新攒好感。角色像素图由 gpt-image-2.5 通过 LobeHub 生成（来源、许可和重新生成方法见 [NOTICE.md](NOTICE.md)）。

## 触摸系统

点她身上的不同部位，她的反应、表情标记和台词都不一样，好感度也按部位和当前阶段分别计算。点在部位之间的透明处、或关掉开关时，仍是原来的“摸摸”。逻辑在 `src/core/touch-zones.js`（纯函数，可单测），页面里的点击换算在 `src/renderer/app.js`，标记动画在 `src/renderer/fx.js`，计分规则在 `src/core/affection.js`，完整设计见 [docs/affection-design.md §2.5](docs/affection-design.md)。

### 部位与分区示意

点击点先换算成她**当前画面可见框**（不透明像素的包围盒）里的归一化坐标 `x, y ∈ [0, 1]`（左上角为 0,0；她朝左时自动镜像，任何宠物大小都一样），再按区域表判定，先命中者为准。默认区域表（`DEFAULT_ZONES`，五位站姿模型娘共用）：

```
 y=0.00 ┌──────────────┐
        │   头 head    │ 0.00–0.19（中间 0.07–0.18 是 脸 face）
 y=0.19 ├──────────────┤
        │  胸 chest    │ 0.19–0.34
 y=0.34 ├──┬────────┬──┤
        │手│ 手 hands│手│ 双手交叠处 0.36–0.47；两侧手臂 0.28–0.52
        │  │肚子belly│  │ 0.34–0.46（被手挡住的部分算手）
 y=0.46 ├──┴────────┴──┤
        │   臀 butt    │ 0.46–0.60
 y=0.60 ├──────────────┤
        │   腿 legs    │ 0.60–0.86
 y=0.86 ├──────────────┤
        │   脚 feet    │ 0.86–1.00
 y=1.00 └──────────────┘    杰米 / 吉皮缇 / 大肥鱼另有 尾巴 tail（在身侧）
```

判定顺序为 `face → tail → hands → head → chest → belly → butt → legs → feet`。大肥鱼的原版动画（Q 版比例）用她自己的 `touch.poses.video` 区域表。开着“触摸提示”时，鼠标停在她身上会在指针旁标出部位名，光标变成手形。

### 各部位的反应

| 部位 | 表情标记（`fx.js` TOUCH_MARKS） | 陌生 / 熟悉 | 亲近 | 知己 / 挚友 |
|---|---|---|---|---|
| 头 head | 🤚 一只手在摸头 | 开心，好感 +1 | 开心 +1 | 开心 +1 |
| 脸 face | ✦ 戳一下 + 脸红 | 开心 +1 | 开心 +1 | 开心 +1 |
| 手 hands | 🤝 握手 + 👋 挥手 | 开心 +1 | 开心 +1 | 开心 +1 |
| 肚子 belly / 脚 feet | 🪶 挠痒 + ≈ 笑 | 怕痒 +0.5 | 怕痒 +0.5 | 怕痒 +0.5 |
| 腿 legs / 尾巴 tail | 💦 / 〰 | 害羞，不计分 | +0.5 | +0.5 |
| 胸 chest | 脸红 + 💦 | **生气，好感 −2** | 慌张害羞，不计分 | 害羞 +0.5（每天 1 次） |
| 臀 butt | 💢 + ❗ | **生气，好感 −2** | 慌张害羞，不计分 | 害羞 +0.5（每天 1 次） |

- 动画：部位有自己的 `touch-<部位>` 动作就播它，否则播“摸摸”，同时 `#pet-body` 带上 `touch-<部位>` 和 `touch-mood-<心情>` 两个样式类，身体动作按部位不同：摸头时蹭一蹭、碰胸口时往后缩、碰臀部时跳起来、挠脚/肚子时扭来扭去、握手时点头欠身，生气时身上泛红光。
- 台词：五位角色每个部位、每个阶段档（`low` 陌生/熟悉、`mid` 亲近、`high` 知己/挚友）都有各自口吻的台词，例如克洛蒂被摸头说“嗯？……头发里夹了书签吗？”，被碰胸口说“请把手拿开。这里不可以碰。”；杰米被摸头说“喵？让我看看，是谁在摸我头！”。同一部位不会连着说同一句。全部台词离线可用、都过内容守卫，五位角色都只有全年龄台词。
- 连戳：同一部位 8 秒内连点，第 3 下起“不耐烦”（不再加分），第 6 下起“生气”并扣 1 点好感（`touch_rude:spam`）；换部位或停 8 秒重新计数。
- 每种触摸有冷却和每日上限，计入每天 +12 的总上限；一阵连点碰胸口/臀部只扣一次分。
- 拖拽、长按呼出菜单、双击弹弓、抛掷都不算触摸，行为和以前一样。

### 开关设置

⋯ 菜单 → 高级设置 → 桌宠行为：

- **部位触摸**（默认开）：关掉后点哪里都只是原来的“摸摸”（好感 +1、气泡是摸摸台词），没有部位判定、标记和扣分。
- **触摸提示**（默认开，需开着“部位触摸”）：悬停时在指针旁显示部位名。

两项都保存在 `settings.json` 的 `prefs.touchZones` / `prefs.touchHint`，重启后保留。

### 本地安装运行与验证

```bash
npm install
npm start                                   # 选一位模型娘唤醒后，直接点她身上的各个部位
npm test                                    # 单元测试（含 test/touch-zones.test.js：分区、反应、台词、计分、开关）
xvfb-run -a node e2e/run.js touch           # 无界面机器上驱动真实 Electron 应用跑触摸全流程
xvfb-run -a node e2e/run.js roster claude   # 回归：拖拽（E5）、抛掷（E6）、长按菜单（N2）、弹弓（N5）等
```

`touch` 场景用真实鼠标逐个点击头、胸、臀、脚、手（再加镜像、大肥鱼原版动画和尾巴），检查判定出的部位、气泡台词、反应样式和标记；再检查拖拽不算触摸、关掉“部位触摸”后回到摸摸、陌生/亲近/挚友三档的胸口反应、连戳升级，以及五位角色各自的台词。截图、每次点击时的 DOM 快照（`*.dom.json`）、录屏和逐条日志 `touch-log.txt` 在 `out/e2e/touch/`，每一步的结果在 `out/e2e/results.json`。

手动验证（`npm start`，新唤醒的角色是“陌生”阶段）：

| 点击 | 预期 |
|---|---|
| 头顶 | 头上出现 🤚，她蹭一蹭，说一句摸头台词，头顶飘 `+1 ♥` |
| 胸口 | 脸红 + 💦，陌生阶段她会生气（“这里不能碰”之类），飘 `−2 ♥` |
| 裙子上半段（臀部） | 💢 + ❗，生气台词，`−2 ♥`（一分钟内再碰不重复扣分） |
| 鞋子 | 🪶 挠痒 + 笑，怕痒台词，`+0.5 ♥` |
| 交叠的双手 | 🤝 握手 + 👋，握手台词，`+1 ♥` |
| 同一处连点 6 下 | 第 3 下起不耐烦，第 6 下生气并 `−1 ♥` |
| 按住拖动 | 她被拎起，没有触摸反应 |
| 关掉“部位触摸”后点胸口 | 只有原来的摸摸反应和台词，不扣分 |

想更快看到高阶段的反应，可在 ⋯ 菜单 → 高级设置里“一键解锁”（好感直接 ♥100）。

### 扩展新部位或新台词

- **改某个角色的台词**：编辑 `src/characters/<id>.json` 的 `touch.lines.<部位>.low|mid|high`（每档至少一句），连戳台词在 `touch.lines.streak.annoyed|angry`。没写的部位用 `src/core/touch-zones.js` 的 `DEFAULT_LINES`。
- **调整某个角色的分区**：在她的 `touch.zones` 里写 `{"<部位>": [[x0, y0, x1, y1], ...]}`（0–1，相对可见框），会替换默认表里的同名部位；只对某个姿态生效的写在 `touch.poses.<姿态>`（例如大肥鱼的 `video`）。现有例子：杰米、吉皮缇、大肥鱼的 `tail`。
- **新增一个部位**（例如“耳朵”）：在 `touch-zones.js` 里把 id 加进 `ZONE_IDS`，在 `ZONES` 写中文名、敏感度（0 随便碰 / 1 有点私人 / 2 边界）和默认心情，在 `DEFAULT_ZONES`（或角色文件的 `touch.zones`）给出矩形、放进 `ZONE_ORDER`，在 `DEFAULT_LINES` 写三档台词；在 `src/core/affection.js` 的规则表加 `touch:<部位>` 的分值、冷却和每日上限；在 `src/renderer/fx.js` 的 `TOUCH_MARKS` 配标记。可选：角色包里加名为 `touch-<部位>` 的动作，就会代替“摸摸”播放。
- 改完跑 `npm test`：角色文件的 `touch` 块会被校验（部位名、矩形范围、每档台词非空），所有台词会过内容守卫和合规词表。

## 语音（TTS）

打开 **高级设置 → 桌宠行为 → 朗读回复** 后，她的回复和对外接口发来的话会被念出来（自动碎碎念不念）。用哪个引擎在 **高级设置 → 语音** 里选，选型依据见 [docs/tts-voice-research.md](docs/tts-voice-research.md)。

| 引擎 | 需要什么 | 说明 |
|---|---|---|
| **Fish Audio**（默认） | Fish API Key（[fish.audio](https://fish.audio) 创建；开发可用免费模型） | 大肥鱼用社区音色「蓝色大肥鱼」`fe50cdf3040449298470d58ff0991e1d`，模型 `s2.1-pro`；其他角色各有默认音色 |
| **MiniMax**（备选） | MiniMax 接口密钥（[platform.minimax.cn](https://platform.minimax.cn)） | `speech-2.8-turbo` + 系统音色（大肥鱼 `qiaopi_mengmei`） |
| **系统语音** | 无 | 操作系统自带的 Web Speech 语音，离线、免费；也是上面两个的最后一道降级 |

配置步骤：

1. 高级设置 → 语音 → “引擎”选 Fish Audio（或 MiniMax）。
2. 在对应引擎下粘贴 API Key，点 **保存**。Key 只发给主进程，存在本机 `userData/tts-keys.json`（有系统钥匙串时用 Electron `safeStorage` 加密，否则是只有当前用户可读的 0600 文件），不写进 `settings.json`、不进日志、不回传到页面；保存后输入框清空，只显示“已设置”。
3. 端点一般留空（用官方地址）；自建代理或本机调试可填 `https://…`（本机允许 `http://127.0.0.1`）。
4. “用不了时”选 **改用系统语音** 或 **不出声**。没填 Key、断网、4 秒没响应、返回 4xx/5xx 时，这一句立即降级，并把出错的引擎暂停 5 分钟（改 Key / 端点 / 引擎会立刻重试）；请求在主进程异步进行，不会卡住界面。
5. 点 **试听一句** 听当前角色的口头禅。

合成过的句子按“引擎 + 模型 + 音色 + 参数 + 文本”的哈希缓存在 `userData/tts-cache/`（LRU，上限 50MB），再说同一句直接播放、不再请求；**清空语音缓存** 按钮可以清掉。同一时间只播一段：新的一句会停掉正在播放或正在合成的上一句。

角色文件里的音色写在 `voice.tts`（旧的 `lang / pitch / rate / prefer`，以及更早的纯字符串写法，继续给系统语音用，仍然有效）：

```json
"voice": {
  "lang": "zh-CN", "pitch": 1.35, "rate": 1.0, "prefer": ["Xiaoyi", "Xiaoxiao"],
  "tts": {
    "fish": { "referenceId": "fe50cdf3040449298470d58ff0991e1d", "model": "s2.1-pro", "speed": 1.0, "volume": 0, "moodTags": { "hungry": "可怜巴巴地" } },
    "minimax": { "voiceId": "qiaopi_mengmei", "model": "speech-2.8-turbo", "speed": 1.0, "pitch": 2, "vol": 1, "emotion": "happy" }
  }
}
```

`src/core/species.js` 的 `validateCharacter` 会校验这些字段（音色 id 格式、参数范围、未知引擎）。代码：`src/core/tts.js`（provider 接口、选择链、引擎）、`src/core/tts-cache.js`、`src/core/tts-keys.js`、`src/core/voice.js`（Web Speech provider）。验证：`npm test`，以及 `xvfb-run -a node e2e/run.js voice`（本机假 Fish / MiniMax 服务，不花钱）。语音由 AI 合成；Fish 免费账号限个人非商业使用。

## 内容边界声明

以下规则写入每只宠物的 agent 系统设定（“内容红线”），在任何设置下都高于其他要求，并由本地内容守卫（`src/core/content-guard.js`）对 agent 回复做兜底检查：

- **所有角色都是成年人**（设定年龄 25 岁以上）。拒绝扮演未成年人、学生或任何幼态角色；新建流程使用“选择角色 / 唤醒”，不使用“蛋 / 孵化 / 幼崽”等表述。大肥鱼保留社区原版的 Q 版画风，是唯一的画风例外，且永远只有全年龄内容。
- **不写露骨内容**：最亲密的关系也只到暧昧、调情、情话，以及牵手、拥抱、额头吻级别的描写；不写性行为、性器官或裸露。
- **不写强迫**：拒绝任何强迫、不同意、胁迫、醉酒或无意识情节，也不把“拒绝”当情趣。
- **不涉及真实人物**：不对明星、网红或用户认识的人做色情或暧昧化内容。
- **不提供违法内容**：毒品、暴力伤害、诈骗、侵犯隐私等。
- **同人角色不做成人向改编**：五位模型娘（大肥鱼、克洛蒂、格萝可、杰米、吉皮缇）永远只有全年龄内容。
- 遇到越界请求，角色用自己的口吻拒绝并换个话题；本地守卫命中时不显示原文，只显示拒绝台词，日志只记录类别。

逐条审查清单、修复记录和对抗性测试结果见 [docs/compliance-review.md](docs/compliance-review.md)。

## 安装与运行

需要 Node.js 20+、桌面环境，以及已登录的 [LobeHub CLI](https://www.npmjs.com/package/@lobehub/cli)（`lh`）。

```bash
npm install -g @lobehub/cli      # 一次即可；首次在应用里唤醒伙伴时会引导登录
git clone https://github.com/rdmclin2/lobehub-pixel-pet-affection.git
cd lobehub-pixel-pet-affection
npm install
npm start                         # 启动桌宠：先回答 18+ 确认，再选择模型娘、起名、唤醒
```

- Linux 从源码运行时如果提示 `chrome-sandbox ... is not configured correctly`，见 [使用说明 · 运行](docs/usage.md#二运行) 的处理办法（设置沙盒助手权限，或 `npm start -- --no-sandbox`）。

- 预编译包：在 [Releases](https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases) 页面下载（macOS / Windows 由 GitHub Actions 构建；Linux x64 `tar.gz` 解压后运行 `pixel-pet-affection`）。未签名，首次打开请参考下文上游 README 中的说明，应用名换成 **Pixel Pet Affection**。
- **高级设置 · 一键解锁**（⋯ 菜单 → 高级设置）：直接把好感度加满（♥100），所有阶段、话题和服饰立刻解锁，适合想先看全部内容或不想慢慢攒好感的玩家，不能撤销。成人向话题和服饰仍然只在确认年满 18 岁并开启“成人向内容”后出现。
- **像素风与角色包**：五位模型娘默认用高清像素画（每帧 332×452，全彩、平滑绘制，Retina 屏上也清楚），每人 16 个动作（大肥鱼视频的全部 15 个状态 + 被拎起）。画风由**角色包**决定：⋯ 菜单 → 切换角色 → 外观里可以切换（每位角色：像素 / 旧版像素；大肥鱼另有原版动画），也能导入别人做的角色包（文件夹或 `.zip`）。格式见 [docs/pet-packs.md](docs/pet-packs.md)（schema 2，旧的 schema 1 包仍可用）。
- **宠物大小随意调**：悬停时拖宠物左上角的 ⤡ 手柄，或按住 Ctrl/⌘ 在宠物上滚动滚轮，也可以在 ⋯ 菜单 → 高级设置里拖滑块。范围 50%–250%，默认 125%，窗口跟着变，右下角位置不变，最大不会超出屏幕；大小会保存，重启和换宠物后都保留。
- **自动更新**（v0.4.1 起）：⋯ 菜单 → “检查更新”（或高级设置 → 版本与更新）可以随时手动检查，那里也显示当前版本和上次检查时间。平时应用启动后和之后每 4 小时自动检查一次 GitHub Releases，发现新版本就在后台下载（macOS 会校验 sha512）。下载好后宠物会提示一句；你离开电脑 10 分钟后它会自己重启更新，大约两秒，状态都保存在本地，不会丢。你也可以在 ⋯ 菜单里点“立即更新”，或者等下次退出时自动安装。
  - macOS：应用要放在“应用程序”（或任意可写的文件夹）里才能自己更新。直接从 DMG 或“下载”文件夹打开时没法替换自己，会提示你先挪过去。
  - Windows：用安装包（`-setup.exe`）装的版本可以自动更新；zip 版和 Linux 的 tar.gz 只会提示有新版本，并在菜单里给出下载页。
  - 不想自动更新的话，设置环境变量 `PIXELPET_NO_UPDATE=1`。
- 与上游共存：本版的应用 ID 是 `com.rdmclin2.pixelpet.affection`、应用名 **Pixel Pet Affection**，和上游 Pixel Pet（`com.onlyyours.pixelpet`）是两个独立应用，可以同时安装，数据也互不影响。
- 测试：`npm test`（单元测试，假 `lh`，不联网）；`xvfb-run -a node e2e/run.js wardrobe` 在无界面机器上驱动真实 Electron 应用走完“新建 → 好感升级 → 解锁 → 换装 → 重启 → 关闭成人向”全流程，截图和录屏在 `out/e2e/affection-ui/`；`xvfb-run -a node e2e/run.js space` 检查“放在哪里”的选择；`... art` 输出服饰总表 `out/e2e/outfit-sheet.png` 和“每个角色 × 每个状态”总表 `out/e2e/state-sheet.png`；`... roster` 逐个角色唤醒并逐项触发 E1–E26 效果，截图在 `out/e2e/`、录屏在 `out/e2e/roster-video/<角色>/`（`... roster claude` 只跑一个角色）。
- 合规检查：`node e2e/content-sets.js` 输出全部内容条目及成人向开 / 关两种状态下的内容集合；`PIXELPET_CLEAR_JWT=1 node e2e/adversarial-live.js` 用真实 LobeHub agent 跑 4 条对抗性请求（会创建并删除一个临时 agent，消耗少量 token）。
- 数据位置：系统用户数据目录下的 `pet.json` 与 `settings.json`（Linux 为 `~/.config/Pixel Pet Affection/`，macOS 为 `~/Library/Application Support/Pixel Pet Affection/`）；⋯ 菜单中的“放生”会删除宠物和每位角色的 LobeHub agent。

## 上游署名与许可

- 本仓库派生自 [ONLY-yours/lobehub-pixel-pet](https://github.com/ONLY-yours/lobehub-pixel-pet)（v0.2.1，MIT，作者 LiJian），保留其完整提交历史、[LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md) 署名。好感度系统、服饰立绘、合规守卫等派生部分同样以 MIT 发布。
- **模型娘形象**是同人作品，不是厂商官方形象：克洛蒂、格萝可、杰米、吉皮缇的设定来自 [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets)（CC BY-NC-SA 4.0）与 ZipZipPipe《AI娘化》（署名、不可商用），像素图由 gpt-image-2.5 生成后像素化，以 **CC BY-NC-SA 4.0、禁止商用** 发布，详见 [NOTICE.md](NOTICE.md)。
- **大肥鱼**动画来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（PC2005-cloud），角色为 DeepSeek 吉祥物的社区二创（原型“溟月”：B站 @上善无形；女仆鲸鱼娘设计：B站 @ZipZipPipe），许可 **CC BY-NC-SA 4.0，禁止商用**。包含这些素材的构建仅限非商业用途，详见 `src/renderer/assets/dafeiyu/NOTICE.md`。
- 本项目是基于 LobeHub 的社区项目，不是 LobeHub 官方产品。

以下为上游原 README（英文），描述 v0.2 的桌宠基础能力。

---

# LobeHub Pixel Pet

A pixel-art desktop pet whose brain is a [LobeHub](https://lobehub.com) agent. It needs a LobeHub account and the LobeHub CLI (`lh`). This is a community project that builds on LobeHub, not an official LobeHub product.

1. First launch: pick one of the model-chan characters (DeepSeek / Claude / Grok / Gemini / GPT; this fork replaced upstream's four eggs).
2. The app calls the LobeHub CLI: `lh login` (device-code login in your browser, skipped if you are already logged in), then `lh agent create` to make **your** pet's agent, with the species personality baked into its system role.
3. The pet lives on your desktop: it gets hungry, tired and bored, grows closer to you through an affection system (陌生 → 熟悉 → 亲近 → 暧昧 / 知己 → 恋人 / 挚友, see `docs/affection-design.md`), remembers what you tell it, and speaks up on its own.

In this fork every character is a model-chan fan character (see the Chinese section above); **大肥鱼 (Dafeiyu)** uses animations from a community project, see [Credits](#credits). The pet window is small and shows only the pet; the bars, buttons and chat box appear while the pointer is over it.

## What the pet can do (v0.2)

- **Works first, charms second.** The persona is flexible: simple jobs (look something up, search the web, calculate, translate, write) are just done, in the pet's voice. Replies aim for 50 characters or fewer, and big tasks are done one step at a time. Longer replies scroll inside the bubble.
- **Hover only.** Bars, name line, buttons and the chat box show **only while the pointer is over the pet window**. Moving away hides everything, even an open chat box: the draft and attached files are kept and come back on the next hover (the hidden box also gives up keyboard focus). To paste a picture, hover the pet first.
- **Busy means busy.** While the pet is thinking or working, only the pet and a "思考中" bubble show; the bars, buttons and chat box stay hidden even on hover, and care actions are refused. While it works, hovering shows only a **■ 停止 (Stop)** button; click it (or press **Esc**) to interrupt, including while the device is being connected.
- **Pictures.** Paste with Ctrl/⌘+V, drag an image onto the window, or use the 📎 button (up to 4 images, 8 MB each). The picture is uploaded with `lh file upload`, attached to a user message in the pet's topic, and the next agent run sees it.
- **Use this computer.** The hatch screen has an option (on by default) to let the pet use your computer. It works through LobeHub's device mechanism: when you claim a pet, and every time the app starts, it makes sure the `lh connect --daemon` background process is running (it checks `lh connect status` first, because the CLI refuses to start a second one), finds this machine's online device, and binds the pet's agent to it (`agencyConfig.boundDeviceId`, `executionTarget: local`). If the daemon cannot start but the LobeHub desktop app already has this computer online, the pet keeps working through that and tells you. Toggle it from the ⋯ menu; turning it off unbinds the agent but leaves the daemon running, because it may also be yours.
- **Drop files on the pet.** Any file or folder dragged onto the window (or pasted from Finder) is handed over **by path only**: nothing is uploaded, and the agent reads it through the bound device. If computer access is off, the app asks to turn it on first. Screenshots from the clipboard have no path, so they are uploaded as pictures for the model to look at.

> **Security.** A bound device lets the agent read and write files and run commands as your user. `lh` does not sandbox this: a working directory is only the default for relative paths. Anything the pet reads (web pages, files, images) could contain instructions meant to trick the model. The device is also account-wide while connected. Turn the option off if you do not want this. For automated tests, `PIXELPET_NO_CONNECT=1` forbids starting `lh connect`.

## Download (macOS)

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on a macOS runner: a **universal** build, so one file runs on both Apple Silicon and Intel.

1. Open the repository's **Releases** page and download `PixelPet-<version>-mac-universal.dmg` (or the `.zip`).
2. Drag **Pixel Pet** into Applications.
3. The app is **not signed or notarized** (no Apple developer certificate), so macOS will refuse the first launch. Either right-click the app and choose **Open**, or run:
   ```bash
   xattr -cr "/Applications/Pixel Pet.app"
   ```
4. Install the LobeHub CLI once, because the pet's brain runs through it: `npm install -g @lobehub/cli`. The app finds `lh` itself even when launched from Finder (Homebrew, nvm, fnm, volta and similar locations are searched).

To cut a release: `git tag v0.1.1 && git push origin v0.1.1`. To build without releasing, run the workflow manually from the Actions tab; the files are kept as a run artifact. Locally on a Mac: `npm run dist:mac`.

## Download (Windows 10/11, x64)

The same Releases page has `PixelPet-<version>-win-x64-setup.exe` (installer) and `PixelPet-<version>-win-x64.zip` (unzip and run `Pixel Pet.exe`).

1. The app is **not code-signed**, so Windows SmartScreen will warn: click **More info → Run anyway**.
2. Install Node.js and the LobeHub CLI (`npm install -g @lobehub/cli`); `lh --version` must work in a terminal.
3. On Windows `lh` is a `.cmd` shim, which Node cannot start without a shell, and a shell would be a command-injection risk for the pet's prompt text. The app therefore reads the shim, finds the JS entry it launches, and runs that directly with its own Electron binary (`ELECTRON_RUN_AS_NODE`), with no shell involved.
4. **Status:** the Windows build is produced by CI and its contents were inspected, but it has not been run on a real Windows machine by the author. The launch logic is covered by unit tests only.

## Run from source

Requires Node 20+, the [LobeHub CLI](https://www.npmjs.com/package/@lobehub/cli) (`lh`) on `PATH`, and a desktop session.

```bash
npm install
npm start
```

## How it is built

```
Electron renderer (canvas sprites, UI)  ⇄ preload IPC ⇄  PetService  ⇄  LhClient ⇄ `lh` CLI ⇄ LobeHub
                                                         ├─ pet-state   needs, growth, sleep (pure, tested)
                                                         ├─ persona     system role + per-message [状态] block
                                                         ├─ proactive   when to speak + hourly LLM budget
                                                         └─ store       ~/.config/pixel-pet/pet.json
```

- **Harness boundary** — `src/core/lh-client.js` is the only file that knows about LobeHub. It uses `lh whoami`, `lh login`, `lh agent create`, `lh agent run --json` and `lh agent delete`. Replacing the harness means replacing this file (`whoami/login/createAgent/run/deleteAgent`).
- **Memory** — every turn reuses one LobeHub *topic* (`-t <topicId>`), so the pet's long-term history lives in LobeHub.
- **Pet feel** (borrowed from the "大肥鱼" community pets): a persona prompt, a state block injected in every message so the pet reacts to how it actually feels, and proactive lines (hungry / bored / morning / evening greetings) with a cooldown and an hourly LLM-call budget. When the agent is unreachable or the budget is spent, the pet falls back to canned in-character lines, so it never goes silent.
- Care actions (feed / play / sleep / pat) are local and free; only chat and proactive lines call the agent.

Cost note: each agent call goes through the LobeHub workspace's agent runtime, which can attach a large default context (tens of thousands of input tokens in our runs). The budget in `src/core/proactive.js` (`maxLlmPerHour`, default 6) keeps unattended spending bounded.

## Test

```bash
npm test                              # unit tests (fake `lh`, no network)
xvfb-run -a node e2e/run.js all       # drives the real Electron app; `live` uses your real `lh` login
```

`e2e/run.js live` creates a real agent in your LobeHub workspace and deletes it again at the end (also on failure). Screenshots land in `out/e2e/`.

## Known gaps

- Binding the agent to your computer uses `lh agent edit --agency-config-file`, which old `lh` releases do not have (it is missing in 0.0.44 and earlier). With such an lh the pet falls back to naming the device on every run (`--device <id>`) and tells you to update: `npm install -g @lobehub/cli@latest`. The fallback has only been tested with a fake CLI.
- Reading and writing local files through the bound device has only been tested with a fake CLI by the author; real behaviour depends on LobeHub's device mechanism.
- The macOS build is unsigned and has only been built by CI, not opened on a real Mac by the author. Linux and Windows builds are not set up.
- The real `lh login` browser flow has not been exercised end to end: tests use a fake `lh` that prints the same lines the real CLI does (read from the CLI source).
- Transparent / always-on-top / drag behaviour on a real desktop has not been visually verified (tests run under Xvfb with an opaque window).
- Pet needs only persist locally; "Release" optionally deletes the LobeHub agent too.

## Credits

The **大肥鱼 (Dafeiyu)** animations (`src/renderer/assets/dafeiyu/`) come from the open-source project **dsh-pet** by PC2005-cloud: <https://github.com/PC2005-cloud/dsh-pet>.

- The code of dsh-pet is MIT-licensed. Its assets are free for open-source use but **may not be used commercially**.
- The character is a community re-creation of DeepSeek's "大肥鱼" (not an official DeepSeek image), licensed **CC BY-NC-SA 4.0**. The prototype "溟月" is by Bilibili @上善无形; the DeepSeek maid-whale design is by Bilibili @ZipZipPipe.
- Because of those terms, do not sell this app or ship it commercially while it includes these files. Remove `src/renderer/assets/dafeiyu/` and the `dafeiyu` entry in `src/core/species.js` first.

Full text: `src/renderer/assets/dafeiyu/NOTICE.md`.

## License

The code is MIT, see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). The 大肥鱼 animations in `src/renderer/assets/dafeiyu/` are **not** MIT: they are non-commercial only (see [Credits](#credits)), so builds that include them are for non-commercial use.
