# dsh-pet 效果差距表

对照对象：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) `main` 分支 commit `8963384`（`fix(notify): 补齐回复正文缓存的清理与文档`），读的是 `README.md`、`FEATURES.md`、`CONFIG.md`、`API.md`、`dsh-pet/assets/config.jsonc`，以及 `dsh-pet/src/shared/`（`pickers.ts`、`motion.ts`、`physics/*`、`score.ts`）、`dsh-pet/src/client/pet/`（`motion/walk.ts`、`motion/drag.ts`、`motion/drag-release.ts`、`motion/touch-press.ts`、`click-sound.ts`、`multi.ts`、`menu-actions.ts`）、`dsh-pet/src/host/`（`memes.ts`、`voice/*`、`balance*`、`notify-events.ts`、`whisper*.ts`、`work-status.ts`）。

本仓库的效果层是 `src/core/fx.js`（纯逻辑）和 `src/renderer/fx.js`（渲染端控制器），五位角色（大肥鱼、克洛蒂、格萝可、杰米、吉皮缇）共用；角色之间只差 `src/characters/<id>.json`、素材和台词。E1–E14 是 T-1158 已交付的效果，E15–E26 是本次（T-1163）新增的。

状态：**已实现**（之前就有）、**本次实现**、**不移植**（附理由）。

## 〇、E1–E14 逐项对照（T-1158 已交付的效果）

| 本仓库 | 效果 | 对应的 dsh-pet 来源 | 结论 | 本次变化 |
| --- | --- | --- | --- | --- |
| E1 | 唤醒演出 `hatch` | dsh-pet 视频素材（本仓库 `assets/dafeiyu/hatch.webm`） | 已实现 | 无 |
| E2 | 待机呼吸 `idle` | `animations.idle`「待机呼吸休闲」 | 已实现 | 无 |
| E3 | 自播链：东张西望 / 转身镜像 / 小动作 / 开心 | `pickers.ts` `rollKind`、`animations.turn`、`next-animation.ts` | 已实现 | 自播链加入“走两步”（D4，E15） |
| E4 | 点击回应 + Q 弹挤压 + 爱心 | `animations.clicks`、`physics/squash.ts` | 已实现 | 一个状态可挂多段片段；大肥鱼 `pat` 4 段、`happy` 2 段轮换（D6）；可选点击音效（E21） |
| E5 | 被拎起 `lifted` | `animations.drag`「被鼠标拖拽悬空反馈」 | 已实现，**本次修复** | 大肥鱼改用 dsh-pet 原生拖拽片段 `lifted.webm`，不再借用 `pat` + ❗（D8） |
| E6 | 甩出：重力、撞边反弹、落地 | `physics/throw.ts`、`release.ts` | 已实现 | 落地挤压随冲击加深（E20）、弹弓（E18）、空中接住（E19）、互撞（E25） |
| E7 | 吃白饭 / 零食 / 水果 | `categories` 吃什么（吃白饭、大口吃零食、吃西瓜） | 已实现 | 无 |
| E8 | 玩耍 `play` | `categories` 玩耍 | 已实现 | 无 |
| E9 | 睡觉 `sleep` | 小动作「原地小憩沉眠」 | 已实现 | 无 |
| E10 | 饿了 / 难过 / 开心 | 小动作与事件动画（`hungry`、`sad`、`happy` 片段） | 已实现 | 无 |
| E11 | 工作状态：思考 → 说话，出错难过；时间背景 | `work-status.ts`、`time-context.ts` | 已实现（部分） | 工具级档位不移植（D36） |
| E12 | 关系升级演出 `evolve` | dsh-pet 视频素材（`evolve.webm`） | 已实现 | 无 |
| E13 | 角色专属衣柜 | 「整体换装试色」的思路；本仓库自有服饰系统 | 已实现 | 无 |
| E14 | 切换角色（保留 agent、记录、好感） | pet pack 种类切换（`pet/<名>-config.json`） | 已实现 | 切换到正在串门的伙伴时，她从同屏伙伴里移除 |

## 一、动画与待机

| # | dsh-pet 效果 | dsh-pet 位置 | 状态 | 本仓库 |
| --- | --- | --- | --- | --- |
| D1 | 待机呼吸 | `animations.idle` | 已实现 | E2 |
| D2 | 随机动画链：按权重在待机 / 转向 / 移动 / 分类动作之间掷骰，不连续重复 | `pickers.ts` `rollKind`、`next-animation.ts` | 已实现，本次补“移动” | E3；`Fx.IDLE_CUES` 新增 `walk`（权重 2，约占自播动作的 1/6） |
| D3 | 转向（播完翻转朝向）与 `noMirror`（带文字的动画不镜像） | `animations.turn`、`categories[].noMirror` | 已实现 | E3、`fx.noMirror` |
| D4 | **自主走位漫游**：朝面向方向走 60–240 px（按尺寸缩放），首尾留白，越界不发车 | `motion.ts` `planMove`、`motion/walk.ts` | **本次实现** | E15：`Fx.planWalk` / `Fx.walkX`；越界先掉头再放弃；鼠标在她身上、忙、开面板时不走；开关“自己走动”，默认开（= dsh-pet 默认 `fixedEnabled: false`） |
| D5 | 宠物固定 `fixedEnabled`（随机链不再转向、不走） | `pets[].fixedEnabled` | **本次实现** | “自己走动”关掉即等价 |
| D6 | 点击回应池（5 段随机，不连抽） | `animations.clicks` | 已实现，本次补素材 | E4；本次通用层支持“一个状态多段片段”（`Fx.pickVariant`），大肥鱼的 `pat` 4 段、`happy` 2 段直接用 dsh-pet 的 `点击回应-*` |
| D7 | 点击 Q 弹挤压 | `physics/squash.ts` | 已实现 | E4 |
| D8 | 拖拽悬空（drag 池） | `animations.drag` | 已实现，本次修大肥鱼 | E5；大肥鱼原来借用 `pat` 视频并叠 ❗，本次换成 dsh-pet 自己的拖拽片段 `被鼠标拖拽悬空反馈.webm`（→ `lifted.webm`），每位角色都有专属拎起美术 |
| D9 | 100+ 段分类动作（小动作 18、玩耍 27、吃什么 12、时节 21、文字 2）和碎碎念 / 工作状态 / 余额事件动画 | `animations.categories`、`events` | 部分 | 通用层已能给任意状态挂多段片段；本次引入了大肥鱼的拖拽、走路和 4 段点击回应。**其余约 80 段不移植**：它们是大肥鱼专属的 640×360 透明视频（共 53 MB），另外三位没有对应美术，为每位重画 80 段动作不在本任务范围；“时节”类还依赖节日素材 |

## 二、交互与物理

| # | dsh-pet 效果 | dsh-pet 位置 | 状态 | 本仓库 |
| --- | --- | --- | --- | --- |
| D10 | 甩抛：重力、撞墙 / 地反弹、地面摩擦 | `physics/throw.ts` | 已实现 | E6 |
| D11 | 落地挤压随冲击速度加深（300→0.8，1500+→0.55） | `physics/squash.ts` `landingSquash` | **本次实现** | E20：`Fx.landingSquash`，`stepThrow` 返回 `impact` |
| D12 | **双击弹弓**：两次按下间隔短 → 拉开松手，朝拉的反方向弹出，力度只看拉距 | `drag.ts` `SLINGSHOT_DOUBLE_MS`、`release.ts` `slingshotVelocity` | **本次实现** | E18：`Fx.isSlingshot`（300 ms）、`Fx.slingshotVelocity`（拉 60% 身宽 = 1200 px/s） |
| D13 | **飞行中点击积分** + 粒子弹窗 | `score.ts`、`score-popup.ts` | **本次实现** | E19：`Fx.clickScore`（≥ 400 px/s，速度 / 100 × 体型加成），“+N”和火花；点中即接住 |
| D14 | **触屏长按 = 右键**（500 ms，移动 8 px 取消） | `motion/touch-press.ts` | **本次实现** | E16：指针事件统一处理鼠标 / 笔 / 触屏，触屏拖拽和甩出同样可用；`Fx.isLongPress` |
| D15 | 右键菜单 | `menu-actions.ts` | **本次实现** | E16：右键她打开 ⋯ 菜单 |
| D16 | 右键“动作”点播任意动画 | 菜单 `动作` | **本次实现** | E17：⋯ → 动作… |
| D17 | 回到原位 | 菜单 | **本次实现** | E17：⋯ → 回到右下角 |
| D18 | 点击音效（默认关，100 ms 节流，多开只响一次） | `click-sound.ts` | **本次实现** | E21：Web Audio 合成的短“啵”声，不带音频文件；默认关 |
| D19 | **多宠互撞**（动量守恒，恢复系数 0.995，质量 ∝ 面积） | `physics/collide.ts` | **本次实现** | E25：`Fx.collidePets` / `Fx.rectsOverlap`；主进程转发各窗口的角色框和速度（`peers` / `kick`），被撞的一方按得到的速度飞出；开关“互相碰撞”默认开 |
| D20 | 多开（同时养多只） | `pets[]`、`multi.ts` | 部分（**本次实现**同屏伙伴） | E24：请最多 3 位其他模型娘以独立小窗口来桌面，所有桌面效果都有。**每只独立 agent / 记忆 / 好感的完整多开不移植**：本应用的存档（`pet.json`）和好感度、衣柜、话题都绑定一个 LobeHub agent，多份并存需要重做存档与 agent 生命周期，超出“效果层”范围 |
| D21 | 弹簧跟手拖拽（K=200、C=30） | `physics/spring.ts`、`drag-follow.ts` | 不移植 | dsh-pet 的弹簧平滑的是浏览器 overlay 里的 DOM 节点；本应用拖的是整个透明窗口，窗口落后于指针时指针会滑出窗口、丢失拖拽，所以窗口直接跟手 |
| D22 | 物理参数设置页（重力、弹性、摩擦、总力度、顶部反弹） | `physics` 配置 | 不移植 | 参数集中在 `Fx.PHYSICS`，开发者可改；没有做成用户设置，避免普通用户把宠物调到飞出屏幕或停不下来（本应用没有“恢复默认”以外的配置文件入口） |
| D23 | 锁定在当前屏幕 / 跨屏飞行 | `confineToScreen` | 已实现（锁定） | 甩抛和走动都以当前所在屏幕的工作区为界，等价于 `confineToScreen: true`；跨屏飞行不移植（多屏工作区并集判定需要多显示器环境验证，本机无法验证） |

## 三、说话、对话与语音

| # | dsh-pet 效果 | dsh-pet 位置 | 状态 | 本仓库 |
| --- | --- | --- | --- | --- |
| D24 | 碎碎念（按周期调用模型说一句） | `whisper.ts` | 已实现 | `src/core/proactive.js`：饿了 / 无聊 / 早晚问候，冷却 12 分钟、每小时最多 6 次模型调用，超出用离线台词 |
| D25 | 对话 + 记忆 | `chat.ts` | 已实现 | LobeHub agent 与话题（E11） |
| D26 | 人设（每只宠物一段） | `whisperPrompt` | 已实现 | `character.json` 的 `personality` |
| D27 | 时间背景（日期、时段、节日） | `time-context.ts` | 已实现 | E11 |
| D28 | 图片：选文件、拖到宠物上、粘贴 | `image-attachment.ts` | 已实现 | 聊天框 📎、拖入、Ctrl/⌘+V |
| D29 | 图片：截当前屏幕 | 同上 | 不移植 | 需要 macOS“屏幕录制”权限和 Electron `desktopCapturer`，还会把整屏内容（可能含隐私）上传给模型；用户可以用系统截图后粘贴 |
| D30 | **梗图**：碎碎念随机配图、对话由模型从清单里选一张 | `memes.ts`、`whisperImageEnabled`、`chatImageEnabled` | **本次实现** | E22：`src/core/memes.js`。每条消息附带她的梗图清单，agent 在末尾写 `[梗图:编号]`，标签不会出现在气泡里；离线台词约 1/3 概率随机配图；只认她自己的图。大肥鱼 9 张取自 dsh-pet（去掉了暧昧 / 擦边和校服样式的几张），另外三位各 4 张由 gpt-image-2.5 生成；开关“梗图”默认开 |
| D31 | **TTS 语音**（edge 在线语音，回复和手动碎碎念会念，自动碎碎念不念，默认关） | `host/voice/*` | **本次实现**（换了引擎） | E23：`src/core/voice.js`，用系统语音（Web Speech API `speechSynthesis`），不联网、不花钱；每位角色在 `voice` 里设音调、语速和偏好的系统语音；念 agent 回复、话题和对外接口发来的话，不念自动碎碎念；默认关。没有用 dsh-pet 的 edge 在线语音：那是微软 Edge 朗读的未公开接口；LobeHub 的 `lh generate tts` 本机实测返回 404（见验收证据），所以选了系统语音 |
| D32 | 聊天窗口（完整历史、勾选删除轮次、清空） | `client/chat/*` | 不移植 | 历史保存在 LobeHub 的 agent 话题里，在 LobeHub 网页 / App 查看和管理；桌宠只显示当前气泡 |
| D33 | 聊天快捷键（悬停按 T）、`/chat` `/pet` 命令 | `chat/shortcut.ts` | 不移植 | 斜杠命令属于 DSH 的输入框；本应用悬停后点“聊天”即可输入 |
| D34 | 模型选择（碎碎念 / 对话各配一个模型） | `model-selection.ts` | 不移植 | 模型由 LobeHub agent 的设置决定，在 LobeHub 里改 |

## 四、工作状态、通知、余额

| # | dsh-pet 效果 | dsh-pet 位置 | 状态 | 本仓库 |
| --- | --- | --- | --- | --- |
| D35 | 工作状态：思考中 / 出结果 / 出错 | `work-status.ts` | 已实现 | E11：等回复时 `think`，回复到达 `talk`，出错 `sad` |
| D36 | 工作状态的工具级档位（工作 / 整理 / 等待批准）与“翻翻 index.ts 看看嘛”式工具文案 | `tool-detail.ts` | 不移植 | 依赖 DSH 宿主的 `session/event`（tool/call、approval/asked）事件流；本应用用 `lh agent run` 一次拿结果，`src/core/lh-client.js` 只解析 `agent_runtime_init` / `stream_start` / `stream_end`，没有工具调用事件的样本，改成流式解析需要先确认 `lh` 的工具事件格式 |
| D37 | 系统通知（窗口失焦时：对话完成、出错、需要确认） | `notify-events.ts` | 不移植 | dsh-pet 通知是因为 DSH 网页可能在后台；本应用的气泡始终置顶显示在桌面上，回复本身就是可见的提醒 |
| D38 | **余额档位**（按“已用 / 总额度”分 6 档播动画 + 气泡） | `host/balance*`、`events.balance` | **不移植** | 缺数据源：LobeHub CLI 没有剩余额度 / 套餐上限。`lh user info --json` 只返回 `createdAt`、`duration`、`updatedAt`；`lh usage --json` 只有逐条消息的 `credits` / `spend` 消耗记录，没有总额度，算不出“已用百分比”。另外 6 段档位动画是大肥鱼专属素材 |

## 五、对外接口与配置

| # | dsh-pet 效果 | dsh-pet 位置 | 状态 | 本仓库 |
| --- | --- | --- | --- | --- |
| D39 | **对外 HTTP 接口**：读状态、说话、点播动画、抛掷、对话 | `API.md`、`host/routes/*` | **本次实现**（子集） | E26：`src/core/api.js` + `src/main/api-server.js`，`GET /pixel-pet/state`、`POST /pixel-pet/say`、`/anim`、`/throw`、`/chat`。默认关；只监听 127.0.0.1；比 dsh-pet 多一道令牌（`Authorization: Bearer`，常数时间比较）和 Host 检查（防 DNS 重绑定），因为桌宠的 `/chat` 会以用户身份调用 LobeHub agent |
| D40 | 占用锁、播放回执、位置控制、第三方菜单项、配置写入 / 重载、外部工作状态槽、语音合成接口 | `API.md` 二、四–九节 | 不移植 | 这些是给 DSH 插件生态做联动演出用的；本应用没有第三方插件宿主，只保留脚本常用的五个接口 |
| D41 | Cordis 服务（同页客户端插件） | `CORDIS.md` | 不适用 | DSH 插件框架专有 |
| D42 | 显示位置（web / desktop / both / none）、浏览器 overlay | `display` | 不适用 | 本应用只有桌面窗口 |
| D43 | 系统托盘 | `trayEnabled` | 不移植 | 托盘在 dsh-pet 里用来把“不在桌面上”的宠物叫回来；本应用的伙伴始终在桌面，⋯ 菜单 / 右键已有设置和退出 |
| D44 | 字体选择 | `font` | 不移植 | 像素字体是本应用视觉的一部分 |
| D45 | 自定义宠物种类（pet pack） | `pet/<名>-config.json` | 已实现 | 角色包（`docs/pet-packs.md`）和角色文件（[usage.md](usage.md#八新增一个厂商角色) 第八节） |
| D46 | 素材生成链（提示词 → 透明视频） | `prompts/`、`scripts/` | 已实现（对应物） | `scripts/art/`：gpt-image-2.5 生成 → 像素化 → 角色包 |

## 六、T-1158 列为未移植的七项：结论

所有“本次实现”的代码都在共享层，对所有角色一视同仁；角色之间只差 `src/characters/<id>.json` 的 `art.clips`（大肥鱼的 `walk` / `lifted` / 点击片段）、`memes`、`voice`，以及 `src/renderer/assets/memes/<id>/` 的图片。所有角色都在 e2e roster 里逐项触发（N1–N14）。

| 效果 | 决策 | 执行层（文件 / 函数） | 开关与默认值 |
| --- | --- | --- | --- |
| 自主走位漫游 | 本次实现（E15） | `src/core/fx.js` `IDLE_CUES`（`walk` 权重 2）、`nextIdleCue({ roam })`、`planWalk`、`walkX`；`src/renderer/fx.js` `walkPet` / `stopWalk`；`src/renderer/app.js` `petPrefs()`（面板打开时不走） | 高级设置 → 桌宠行为 →“自己走动”，**默认开、低强度**：只在鼠标不在她身上、她不忙、没开面板时由自播链触发，约占自播动作的 1/6（自播每 12–25 秒一次，平均约 100 秒走一次），每次 60–240 px，到屏幕边掉头；与 dsh-pet 默认（`fixedEnabled: false`）一致 |
| 触屏 / 长按交互 | 本次实现（E16，另含右键菜单、触屏拖拽 / 甩出） | `src/core/fx.js` `LONG_PRESS`、`isLongPress`；`src/renderer/app.js` `bindPetPointer`（指针事件统一鼠标 / 笔 / 触屏）、`openMenuAtPet` | 不干扰用户，无开关 |
| 多宠互撞 | 本次实现（E24 同屏伙伴 + E25 碰撞） | `src/core/fx.js` `rectsOverlap`、`collidePets`；`src/renderer/fx.js` `throwPet`（查 `peers`、发 `kick`）、`kicked`；`src/main/main.js` `syncVisitors`、`pose` / `peers` / `kick` IPC | 同屏伙伴**默认没有**（要自己在高级设置 → 同屏伙伴勾选，最多 3 位）；“互相碰撞”默认开，只在有伙伴且她被甩出时生效 |
| TTS | 本次实现（E23，系统语音） | `src/core/voice.js` `voiceOf`、`speakable`、`shouldSpeak`、`pickVoice`；`src/renderer/app.js` `speak` | “朗读回复”**默认关**；只念 agent 回复、话题和对外接口的话 |
| 梗图 | 本次实现（E22） | `src/core/memes.js` `memeHint`、`extractMeme`、`randomMeme`；`src/core/persona.js` `buildStateBlock`（附清单）；`src/main/pet-service.js` `_say`；`src/renderer/app.js` `say`（贴纸） | “梗图”默认开（只是气泡旁的贴纸，不打扰） |
| 余额档位 | **不移植** | — | 缺数据源：`lh user info --json` 只有 `createdAt` / `duration` / `updatedAt`，`lh usage --json` 只有逐条消息的 `credits` / `spend`，LobeHub CLI 不提供剩余额度或套餐上限，算不出 dsh-pet 的“已用 / 总额度”百分比档位；6 段档位动画也是大肥鱼专属素材 |
| 对外 HTTP API | 本次实现（E26，五个接口） | `src/core/api.js` `handle`、`sameToken`、`throwVelocity`；`src/main/api-server.js` `ApiServer`；`src/main/main.js` `askRenderer`；`src/renderer/app.js` `onApiCmd` | **默认关**；开启时生成随机令牌；只监听 127.0.0.1，校验 `Authorization: Bearer` 和 Host（防 DNS 重绑定），因为 `/chat` 会以用户身份调用 agent |

## 七、验证

- `npm test`：`test/dsh-effects.test.js` 覆盖走位规划、弹弓、积分、落地挤压、长按、碰撞、片段轮换、梗图（每位角色各一遍）、语音参数与选音色、同屏伙伴与接口设置、HTTP 路由与真实监听。
- `xvfb-run -a node e2e/run.js roster`：每位角色在真实 Electron 窗口里逐项触发 N1–N14（走动、长按菜单、右键与回到右下角、动作点播、弹弓、空中接住、落地挤压、行为设置、点击音效、梗图、朗读、同屏伙伴、互撞、HTTP 接口），截图在 `out/e2e/roster-<角色>-*.png`，录屏在 `out/e2e/roster-video/<角色>/`。
