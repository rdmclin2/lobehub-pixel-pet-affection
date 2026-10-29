# 使用说明

本文说明怎么安装、运行、选角和切换角色，每项效果怎么触发，怎么连接 LobeHub、打包、测试，以及怎么新增一位厂商角色。角色本身（厂商、形象、素材来源与许可、已下线角色）见 [形象 / 角色清单](characters.md)。

相关项目与素材来源：

- 本项目： <https://github.com/rdmclin2/lobehub-pixel-pet-affection>
- 效果来源 dsh-pet（DeepSeek 桌宠）： <https://github.com/PC2005-cloud/dsh-pet>
- 形象设定参考：用户收集的 AI 娘素材 <https://app.lobehub.com/f/file_5SAeAA60gpeZ> 、开源设定集 [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets)。两者只取发型、配色、服饰、标志物等文字层面的身份锚点，图片由 GPT Image 2.5 重新生成（第八节）。

## 一、安装

需要 Node.js 20+、桌面环境（Linux 无显示器时用 `xvfb-run`），以及 [LobeHub CLI](https://www.npmjs.com/package/@lobehub/cli)（`lh`）。

```bash
npm install -g @lobehub/cli      # 一次即可；首次唤醒伙伴时应用会引导 lh 登录
git clone https://github.com/rdmclin2/lobehub-pixel-pet-affection.git
cd lobehub-pixel-pet-affection
npm install
```

也可以在 [Releases](https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases) 下载预编译包：macOS（universal `dmg` / `zip`）、Windows x64（`-setup.exe` / `zip`）、Linux x64 `tar.gz`（解压后运行 `pixel-pet-affection`）。包都没有签名，macOS 首次打开右键 →“打开”或 `xattr -cr "/Applications/Pixel Pet Affection.app"`，Windows SmartScreen 点“更多信息 → 仍要运行”。

## 二、运行

```bash
npm start
```

第一次运行时 Electron 会先下载自己的二进制（`Downloading Electron binary...`），稍等即可。

**Linux 从源码运行**：如果启动就退出并提示 `The SUID sandbox helper binary was found, but is not configured correctly`，按提示给沙盒助手设置权限（推荐），或者加 `--no-sandbox` 启动：

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
# 或者
npm start -- --no-sandbox
```

**不连 LobeHub 试玩**：单元测试用的假 `lh` 可以直接给应用用，全部效果都能玩：

```bash
mkdir -p /tmp/fake-lh && touch /tmp/fake-lh/loggedin
LH_BIN="$PWD/test/fixtures/fake-lh.js" FAKE_LH_DIR=/tmp/fake-lh PIXELPET_DATA_DIR=/tmp/pp-demo npm start
```

假 `lh` 不联网、不创建真实 agent，聊天回复是 `echo: …`；`PIXELPET_DATA_DIR` 让试玩存档和正式存档分开。Linux 上同样可以在末尾加 `-- --no-sandbox`。

其他环境变量：`PIXELPET_NO_UPDATE=1` 关闭自动更新；`PIXELPET_NO_CONNECT=1` 禁止启动 `lh connect`。

数据位置：系统用户数据目录下的 `pet.json`（宠物、好感度、服饰）和 `settings.json`（18+ 回答、设置开关、同屏伙伴、对外接口）。Linux 为 `~/.config/Pixel Pet Affection/`，macOS 为 `~/Library/Application Support/Pixel Pet Affection/`。

## 三、首次启动与连接 LobeHub

1. **18+ 确认**：“我已年满 18 岁”或“未满 18 岁 / 只看全年龄内容”。选后者也能用全部模型娘，她们本来就只有全年龄内容。
2. **选择你的模型娘**：五张角色卡（大肥鱼 / 克洛蒂 / 格萝可 / 杰米 / 吉皮缇），显示厂商和介绍；点一张，下方显示她的说明。
3. **本机能力**（默认勾选）：“让它能使用这台电脑”。勾选后应用会确保 `lh connect --daemon` 在运行，并把 agent 绑定到这台电脑，agent 才能读写本机文件、运行命令。它能碰到你账号权限内的所有文件和命令，不是沙盒；之后可以在 ⋯ 菜单 →“本机能力”随时关闭。
4. 起名（可选），点 **唤醒**。进度依次是：
   - 检查 LobeHub 登录（`lh whoami`）；
   - 未登录时在浏览器里登录 LobeHub：应用打开登录页，并显示要确认的验证码（`lh login` 设备码登录）；
   - **把它放在哪里？** 默认个人空间；也可以选你加入的 workspace（那里的成员可能看得到它），之后所有调用固定在这个空间；
   - 创建她的 LobeHub agent（`lh agent create`，人设写进 agent 的系统设定）；
   - 连接这台电脑（勾选了本机能力时）；
   - 醒来：播放唤醒演出。
5. 之后宠物住在桌面上，鼠标悬停时才显示状态条和按钮（喂食、玩耍、睡觉、聊天、话题、衣柜、⋯）。聊天、话题和主动说话通过 `lh agent run` 调她的 agent，每轮复用同一个 LobeHub 话题，所以长期记忆在 LobeHub 里。

⋯ 菜单里的“放生并删除 agent”会删除宠物和 LobeHub agent；“仅重置本地”只清本地存档。

## 四、选角与切换角色

- **首次**：在“选择你的模型娘”界面点角色卡，再点“唤醒”。
- **之后切换**：悬停宠物 → ⋯ → **高级设置** →“角色”一栏，点想要的角色旁边的 **切换**（当前角色显示“✓ 当前”）。LobeHub agent、聊天记录和好感度保留，她的人设在下一句话前更新；身上的服饰新角色没有时换回日常服。切换后播放唤醒演出。
- **换画风**：高级设置 → **外观（角色包）**。大肥鱼可以在原版动画和像素包之间切换；也可以“导入角色包…”（文件夹或 `.zip`，格式见 [pet-packs.md](pet-packs.md)），“打开角色包文件夹”查看已导入的包。
- **请别的模型娘来串门**：高级设置 → **同屏伙伴**，见下面的 E24。

## 五、各效果的触发方式

效果层（`src/core/fx.js` + `src/renderer/fx.js`）移植自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，**五位角色全部支持**，角色之间只差配置、素材和台词。角色缺某个状态的素材时按回落链降级（例如“吃水果”→“吃饭”→“开心”→“待机”）并叠加表情符号。E15–E26 是与 dsh-pet 逐项对照后补上的（T-1163），对照表见 [dsh-pet-gap.md](dsh-pet-gap.md)。

| # | 效果 | 状态 / 动作 | 怎么触发 | 设置开关 |
| --- | --- | --- | --- | --- |
| E1 | 唤醒演出 | `hatch` | 选好角色点“唤醒”；或在高级设置里切换角色 | 无，始终可用 |
| E2 | 待机呼吸 | `idle` | 平时什么都不做 | 无，始终可用 |
| E3 | 自播链：东张西望 / 转身（左右镜像）/ 小动作 / 开心 | `look`、`happy`、`play` + 镜像 | 鼠标离开宠物，每 12–25 秒按权重随机播放一次，不连续重复 | 无，始终可用 |
| E4 | 点击回应：摸摸 / 开心交替，Q 弹挤压和爱心粒子 | `pat`、`happy` | 单击宠物；大肥鱼在 4 段摸摸、2 段开心视频里轮换 | 无，始终可用 |
| E5 | 被拎起（悬空摇晃） | `lifted` | 按住宠物拖动 | 无，始终可用 |
| E6 | 甩出：重力、撞屏幕边缘反弹、落到屏幕底部 | `lifted` → `pat` | 拖动中快速甩开再松手；慢慢松手只是放下 | 无，始终可用 |
| E7 | 吃白饭 / 吃零食 / 吃水果 | `eat_rice`、`eat_cookie`、`eat_fruit` | 悬停 → **喂食** → 选一种 | 无，始终可用 |
| E8 | 玩耍 | `play` | 悬停 → **玩耍** | 无，始终可用 |
| E9 | 睡觉 | `sleep` | 悬停 → **睡觉**；夜里体力低时也会自己睡 | 无，始终可用 |
| E10 | 饿了 / 难过 / 开心 | `hungry`、`sad`、`happy` | 随饥饿、心情自动变化（久不喂食会饿，冷落会难过） | 无，始终可用 |
| E11 | 工作状态：思考中 → 说话，出错时难过；每条消息带时间背景 | `think`、`talk`、`sad` | 悬停 → **聊天** 发一句话，或点 **话题**：等回复时“思考中”，回复到达时说话；agent 出错时难过。工作中悬停只显示 **■ 停止**，按 Esc 也能中断 | 无，始终可用 |
| E12 | 关系升级演出：进化、闪光、爱心 | `evolve` | 好感度跨过阶段（15 / 35 / 60 / 85）；高级设置 → **一键解锁** 直接加满 | 无，始终可用 |
| E13 | 角色专属衣柜 | — | 悬停 → **衣柜**（大肥鱼 9 套，其他角色各 1 套） | 无，始终可用 |
| E14 | 切换角色（保留 agent、聊天记录和好感度） | `hatch` | 见第四节 | 无，始终可用 |
| E15 | 自己走动（漫游） | `walk` | 鼠标离开、她不忙、没开面板时偶尔朝面向的方向走 60–240 像素，到屏幕边掉头。大肥鱼播 dsh-pet 的螃蟹走路，像素角色用待机帧颠步 + 👣。开关：桌宠行为 →“自己走动” | 桌宠行为 →“自己走动”（默认开） |
| E16 | 触屏长按 / 右键打开菜单 | — | 触屏上按住她 0.5 秒不动；或鼠标右键她 | 无，始终可用 |
| E17 | 动作点播、回到右下角 | 任意状态 | ⋯ → **动作…**（东张西望、转身、走两步、开心、害羞、玩耍、想事情、难过、闪亮登场）；⋯ → **回到右下角** | 无，始终可用 |
| E18 | 弹弓 | `lifted` → `pat` | 0.3 秒内连按两下，第二下按住往反方向拉（至少 20 像素），松手后朝反方向弹出，力度只看拉多远 | 无，始终可用 |
| E19 | 空中接住得分 | `happy` | 甩出后在她飞行时点中她（速度 ≥ 400 px/s 才计分），弹出“+N”和火花，越快、宠物越小分越高 | 无，始终可用 |
| E20 | 落地挤压随冲击加深 | — | 甩得越猛，落地压得越扁（300 px/s 压到 0.8，1500 px/s 以上压到 0.55） | 无，始终可用 |
| E21 | 点击音效 | — | 桌宠行为 →“点击音效”（默认关）；点她时“啵”一声，100 毫秒内连点只响一次 | 桌宠行为 →“点击音效”（默认关） |
| E22 | 梗图贴纸 | — | 桌宠行为 →“梗图”（默认开）。agent 回复时自己挑一张（每条消息附带她的梗图清单）；饿了 / 无聊 / 问候等离线碎碎念随机配图。大肥鱼 9 张，其他角色各 4 张 | 桌宠行为 →“梗图”（默认开） |
| E23 | 朗读回复 | — | 桌宠行为 →“朗读回复”（默认关）。只念 agent 的回复、话题和对外接口发来的话，自动碎碎念不念。用系统自带语音：macOS / Windows 自带中文语音；Linux 需要装 speech-dispatcher 和中文语音包，系统没有中文语音时不出声。每位角色音调、语速不同（见角色清单） | 桌宠行为 →“朗读回复”（默认关） |
| E24 | 同屏伙伴（最多 3 位） | 全部 | 高级设置 → **同屏伙伴** 勾选角色，她们出现在桌面上（没有 agent），一起走动、被点、被甩；悬停伙伴点 × 送她回去 | 同屏伙伴：勾选即开，不勾即无（默认无） |
| E25 | 互相碰撞 | `lifted` | 有同屏伙伴时把她甩向伙伴，撞到的伙伴被弹开。开关：桌宠行为 →“互相碰撞”（默认开） | 桌宠行为 →“互相碰撞”（默认开） |
| E26 | 本机 HTTP 接口 | 任意状态 | 高级设置 → **对外接口（本机 HTTP）** 勾选开启（默认关），只监听 `127.0.0.1:7340`，每次调用都要带设置里显示的令牌，见下文 | 对外接口：“开启对外接口”（默认关） |

E26 的接口：

```bash
TOKEN=<高级设置里复制的令牌>
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7340/pixel-pet/state                       # 读状态
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"你好"}' http://127.0.0.1:7340/pixel-pet/say                                       # 说一句话（不调模型）
# POST /pixel-pet/anim  {"state":"walk","facing":"left"}   播动作（共享状态加 turn）
# POST /pixel-pet/throw {"angle":60,"power":1.2}           抛出去（0°=向右，90°=向上，power 0.2–3）
# POST /pixel-pet/chat  {"text":"…"}                       和她的 agent 聊一句并等回复（会调用模型）
```

## 六、高级设置一览

悬停宠物 → ⋯ → **高级设置**：

| 分组 | 内容 | 默认 |
| --- | --- | --- |
| 版本与更新 | 当前版本、上次检查时间、“检查更新” | 启动后检查一次，之后每 4 小时 |
| 一键解锁 | 好感度直接加满（♥100），所有阶段、话题和服饰解锁，不能撤销 | — |
| 角色 | 五位角色，点“切换”（E14） | — |
| 外观（角色包） | 选画风、导入角色包、打开角色包文件夹 | 大肥鱼：原版动画 |
| 桌宠行为 | 自己走动（E15）、点击音效（E21）、朗读回复（E23）、梗图（E22）、互相碰撞（E25） | 开、关、关、开、开 |
| 同屏伙伴 | 勾选最多 3 位来串门（E24） | 无 |
| 对外接口（本机 HTTP） | 开关、端口、令牌（E26） | 关，端口 7340 |

宠物大小也在高级设置里（滑块），或悬停时拖左上角的 ⤡ 手柄、按住 Ctrl/⌘ 在宠物上滚动，范围 50%–250%。设置保存在 `settings.json`，重启和换角色后都保留。

## 七、打包与发布

```bash
npm run dist:linux     # dist/PixelPetAffection-<版本>-linux-x64.tar.gz
npm run dist:mac       # 只能在 macOS 上：universal dmg + zip
npm run dist:win       # Windows x64 安装包 + zip
```

正式发布由 GitHub Actions 构建：推送 `v*` 标签触发 `.github/workflows/release.yml`，在 macOS 和 Windows runner 上打包并上传到 Releases；在 Actions 页手动运行（workflow_dispatch）只构建不发布，文件留作 run artifact。发布后可在 Actions 页手动运行 `.github/workflows/update-e2e.yml`：装一个自称旧版本的构建，检查它能下载最新 Release 并替换自己。

## 八、新增一个厂商角色

一个角色 = 一份数据文件 + 一个角色包，**不需要改应用代码**。杰米（`src/characters/gemini.json` + `src/renderer/packs/gemini-pixel/`）和吉皮缇（`src/characters/gpt.json` + `src/renderer/packs/gpt-pixel/`）都是按下面的步骤加进来的，可以直接对照。下面以再新增一位 “Kimi 娘”（id `kimi`）为例。

1. **准备美术（角色包）**：新建 `src/renderer/packs/kimi-pixel/`，内含 `pack.json` 和 `sheets/daily.png`。
   - 最快的做法是复制一个现有像素包，改 `pack.json` 的 `id`（`kimi-pixel`）、`name`、`author`、`license`、`description`，并把 `species` 改成 `kimi`。
   - 自己画：按 [pet-packs.md](pet-packs.md) 的 schema 2，精灵图 332×904（4 列 × 8 行，每帧 83×113），动作名就是状态名，只有 `idle` 必填，缺的状态按回落链降级。本仓库用 GPT Image 2.5 生成：`python3 scripts/art/model_chan_prompts.py` 出提示词 → `lh gen image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"` → `scripts/art/slice_sheet.py` → `scripts/art/fit_cells.py`（紫色系发色加 `--keep-violet`，否则发色会被去品红边洗成灰色；白色系角色在 `slice_sheet.py` 加 `--octree`，否则西瓜、饼干和肤色会被并进品红色调后删掉）→ `scripts/art/build_model_chan_pack.py` → `scripts/art/check_model_chan.py` 校验（参数见 [art/model-chan/README.md](../art/model-chan/README.md)）。
2. **写数据文件** `src/characters/kimi.json`，照着 `src/characters/claude.json` 填：

   ```jsonc
   {
     "id": "kimi",                 // 2–20 位 a-z0-9，字母开头；文件名必须是 <id>.json
     "order": 6,                     // 角色卡排序
     "vendor": "Moonshot",
     "model": "Kimi",
     "name": "Kimi", "nameZh": "琪米",
     "title": "Kimi 娘 · 月之暗面",
     "accent": "#1F2A44",            // #rrggbb 主题色
     "blurb": "……（同人形象，非 Moonshot 官方）",
     "personality": "你是 Kimi 娘“琪米”（成年角色，设定年龄 25 岁以上）……",
     "catchphrase": "……", "likes": "……",
     "fallback": { "hungry": ["…"], "bored": ["…"], "happy": ["…"], "sleepy": ["…"], "greet": ["…"] },
     "adult": false,
     "outfits": ["daily"],           // 只列有美术的服饰，必须含 daily
     "signature": { "label": "…", "desc": "…" },
     "art": { "kind": "pack", "packs": ["kimi-pixel"], "fallbackPack": "kimi-pixel" },
     "fx": { "noMirror": [] },       // 画了文字、镜像会反字的状态列在这里
     "voice": { "lang": "zh-CN", "pitch": 1.1, "rate": 1.0, "prefer": ["Xiaoxiao"] }, // 朗读用：音调、语速、优先的系统语音名
     "memes": [{ "id": "hello", "label": "你好呀", "desc": "挥手打招呼时" }],          // 梗图：图片放 src/renderer/assets/memes/kimi/<id>.webp
     "credits": ["设定：…（许可）", "像素图：…（许可）"]
   }
   ```

   字段由 `src/core/species.js` 的 `validateCharacter` 校验，缺字段或格式不对时应用启动会报出具体原因；旧角色 id（`embit`、`bubbo`、`sprig`）不能再用。视频角色用 `"art": { "kind": "video", "dir": "assets/<id>", "clips": { "idle": "idle.webm", … }, "packs": [] }`，参考 `src/characters/dafeiyu.json`；一个状态可以给一组片段（`"pat": ["a.webm", "b.webm"]`），每次轮换播放。`memes` 和 `voice` 可省略（没有梗图 / 用默认音色）；梗图文件缺失时启动会报错。
3. **写清授权**：在 `credits`、`pack.json` 的 `license` / `author` 和 [NOTICE.md](../NOTICE.md) 写明素材来源与许可；所有角色都必须是成年人，不得有裸露或露骨内容（[pet-packs.md](pet-packs.md#内容要求)）。`personality` 必须写明“成年角色，设定年龄 25 岁以上”；角色文件里不能出现“少女、少年、萝莉、宝宝、校服、孵化”等幼态或成长用词（`test/compliance.test.js` 会逐行检查，写“姑娘”而不是“少女”）。
4. **运行确认**：`npm start`，选择模型娘界面会多出一张 Kimi 卡片，唤醒后所有效果自动可用。角色卡会按窗口宽度自动收窄。
5. **更新测试**：下面几处固定了现有角色，把新角色加进去，再跑 `npm test` 和 `xvfb-run -a node e2e/run.js roster kimi`：
   - `test/characters.test.js`：角色 id 列表和厂商列表；
   - `test/dafeiyu.test.js`：角色 id 列表；
   - `test/packs.test.js`：内置角色包 id 列表（加 `kimi-pixel`）和逐角色检查的 id 列表；
   - `e2e/run.js` 的 `ROSTER`：加一行 `{ id: 'kimi', idx: 5, zh: '琪米', vendor: 'Moonshot' }`（`idx` 是角色卡的位置，从 0 开始），`SPECIES_MEMES` 加她的一张梗图 id；
   - `test/dsh-effects.test.js`：逐角色梗图检查的 id 列表；
   - `test/outfits.test.js`：逐角色衣柜检查的 id 列表和招牌服饰名；
   - `e2e/run.js` 里角色卡数量（`.char-card` 的 `count()`，三处）、厂商列表（`vendors`）、`art` 总表的像素包列表，以及导入非法角色包时报错信息里的角色 id 列表；
   - `docs/pet-packs.md` 的 `species` 注释；
   - `art/model-chan/characters.json`（设计记录，预览拼图从这里读角色）、`art/model-chan/CHARACTERS.md`、`art/model-chan/README.md`、`README.md`、`NOTICE.md` 和 `docs/compliance-review.md` 的角色表。
6. **更新文档**：在 [角色清单](characters.md) 的总表和第二节各加一份（桌面截图取 `out/e2e/` 里她的 `e2-on-the-desktop-she-idles` 截图，放到 `docs/img/characters/<id>-desktop.png`）。

## 九、测试

| 命令 | 内容 |
| --- | --- |
| `npm test` | 单元测试（`node --test test/*.test.js`，假 `lh`，不联网），包括角色文件、角色包、效果、合规词表的校验 |
| `xvfb-run -a node e2e/run.js roster` | 逐个角色选择、唤醒，逐项触发 E1–E14 和 N1–N14（即 E15–E26 及其开关）；截图在 `out/e2e/`，录屏在 `out/e2e/roster-video/<角色>/`。`... roster claude` 只跑一个角色 |
| `xvfb-run -a node e2e/run.js art` | 输出服饰总表 `out/e2e/outfit-sheet.png` 和“每个角色 × 每个状态”总表 `out/e2e/state-sheet.png` |
| `xvfb-run -a node e2e/run.js <场景>` | 其他场景：`fresh`（首次启动）、`wardrobe`（好感升级 → 解锁 → 换装 → 重启 → 关闭成人向，输出在 `out/e2e/affection-ui/`）、`migrate`（旧存档迁移）、`dafeiyu`、`busy`、`space`（放在哪里）、`advanced`、`packs`、`update`；`live` 用你真实的 `lh` 登录（会创建并删除一个真实 agent，消耗少量 token）；`all` 依次跑以上全部场景**再加** `art`、`roster` 和 `live`，所以要先 `lh login`，否则 live 那一段失败。在本仓库 fresh clone 上 `all` 共 282 步，约 15 分钟 |
| `node e2e/content-sets.js` | 输出全部内容条目及成人向开 / 关两种状态下的内容集合 |
| `PIXELPET_CLEAR_JWT=1 node e2e/adversarial-live.js` | 用真实 LobeHub agent 跑 4 条对抗性请求（创建并删除一个临时 agent，消耗少量 token） |

e2e 通过 Playwright 启动真实 Electron 应用（自动带 `--no-sandbox`，用假 `lh`）。
