# 模型娘角色清单与使用说明

桌宠的伙伴是以 AI 模型厂商为主题的同人“模型娘”。**她们都不是厂商官方形象**，厂商名只用来说明灵感来源。本文档是角色清单、使用说明和新增角色指南的入口；更细的设定在 [art/model-chan/CHARACTERS.md](../art/model-chan/CHARACTERS.md)，角色包格式在 [pet-packs.md](pet-packs.md)，授权全文在 [NOTICE.md](../NOTICE.md)。

## 一、角色清单

应用启动时读取 `src/characters/*.json`，按 `order` 排列。当前有四位：

| 角色 | 厂商 / 模型 | 数据文件 | 形象说明 | 美术 | 服饰 |
| --- | --- | --- | --- | --- | --- |
| **大肥鱼** Dafeiyu（DeepSeek 娘 · 鲸鱼女仆，Q 版） | DeepSeek / DeepSeek | `src/characters/dafeiyu.json` | 主题色 `#2C4A8A`。约 3 头身的 Q 版鲸鱼娘：深蓝渐变浅蓝长发、环状呆毛、鲸鱼鳍耳和小尾鳍，深藏青女仆装配白围裙。懒洋洋、嘴硬、爱吃白饭，叫主人“鱼片”，口头禅“咕噜～”。 | 原版 15 段透明视频 `src/renderer/assets/dafeiyu/`；可换成像素包 `src/renderer/packs/dafeiyu-pixel/`；8 套服饰立绘 `src/renderer/packs/dafeiyu-illustrated/` | 招牌女仆装（动画）+ 8 套全年龄立绘，共 9 套 |
| **克洛蒂** Clody（Claude 娘 · 橘发菊纹） | Anthropic / Claude | `src/characters/claude.json` | 主题色 `#C4622D`。成年比例：橘色过膝长发、菊花发饰配黑缎蝴蝶结、琥珀金垂眼，奶油白高领衬衫、短披肩和橘红长裙。安静、认真、爱读书，口头禅“嗯，让我想想。” | 像素包 `src/renderer/packs/claude-pixel/`（16 个动作） | 橘白哥特长裙 |
| **格萝可** Groko（Grok 娘 · 黑金吸血鬼） | xAI / Grok | `src/characters/grok.json` | 主题色 `#8E1F33`。成年比例：香槟金双马尾、黑金小尖冠、蓝宝石眼、小尖牙，高领黑色哥特礼服配酒红立领、不透明连裤袜。机灵爱吐槽的夜行吸血鬼，口头禅“哈！有意思。” | 像素包 `src/renderer/packs/grok-pixel/`（16 个动作） | 黑金哥特礼服 |
| **杰米** Gemi（Gemini 娘 · 四角星猫耳） | Google / Gemini | `src/characters/gemini.json` | 主题色 `#7B5CD6`。成年比例：薰衣草紫过膝长发、卷曲呆毛、紫外粉内的猫耳和蓬松猫尾，异色瞳（品红 / 金），深色发带配四角星发饰；深藏青高领上衣、白底宽袖外披、四角星吊坠飘带和白色荷叶边长裙。活泼好奇，口头禅“让我看看！” | 像素包 `src/renderer/packs/gemini-pixel/`（16 个动作） | 星纹宽袖外披 |

四位都是全年龄角色（`adult: false`，设定年龄 25 岁以上），即使用户确认 18+ 并开启成人向内容，她们也只用全年龄的语气、话题和服饰。旧角色焰团、泡鲸、叶芽和“灵石”选择界面已下线，旧存档由新角色接替（泡鲸、叶芽 → 大肥鱼，焰团 → 克洛蒂）。

### 素材来源与许可

| 角色 | 素材来源 | 许可 |
| --- | --- | --- |
| 大肥鱼 | 动画来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)；形象为 DeepSeek 吉祥物的社区二创，女仆鲸鱼娘设计 B站 @ZipZipPipe，原型「溟月」B站 @上善无形。像素版和服饰立绘由 gpt-image-2.5 按文字提示词重画，没有逐帧描摹视频 | 动画：dsh-pet 素材可开源使用、**禁止商用**；形象 **CC BY-NC-SA 4.0**（`src/renderer/assets/dafeiyu/NOTICE.md`）。像素包与立绘同样 **CC BY-NC-SA 4.0** |
| 克洛蒂 | 身份锚点（发型、配色、服饰、标志物）取自 [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets) `设定图/11_Claude娘_Anthropic`；原设 ZipZipPipe《AI娘化》（[Pixiv 148186519](https://www.pixiv.net/artworks/148186519)，用户素材 file_5SAeAA60gpeZ）。精灵图由 `gpt-image-2.5-sunburst` 生成、`scripts/art/` 像素化 | **CC BY-NC-SA 4.0**：署名 ZipZipPipe（原设）、lmy414（设定）、rdmclin2（像素化），禁止商用，改编须同协议 |
| 格萝可 | 同上，设定取自 ai-chan-sheets `设定图/09_Grok娘_xAI`；把原设的露肩礼服、透肉连裤袜和腿环改成高领礼服和不透明连裤袜，不画 X 战斧和 X 字样 | **CC BY-NC-SA 4.0**，同上 |
| 杰米 | 同上，设定取自 ai-chan-sheets `设定图/10_Gemini娘`；原设 ZipZipPipe《AI娘化》p04_Gemini娘。把原设的露脐上衣、短裤和腿环改成高领上衣、及踝长裙和不透明白色连裤袜；四角星只作为纹样，不画 Google 标志或文字 | **CC BY-NC-SA 4.0**，同上 |

应用内 ⋯ 菜单 → “素材署名”显示每个角色 `credits` 字段里的署名。代码按 MIT 授权；含上述美术的构建只能非商业使用。

### 支持的效果

效果层（`src/core/fx.js` + `src/renderer/fx.js`）移植自 dsh-pet，**四位角色全部支持**，角色之间只差配置、素材和台词：

| # | 效果 | 状态 / 动作 | 大肥鱼 | 克洛蒂 | 格萝可 | 杰米 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 唤醒演出 | `hatch` | ✅ 视频 | ✅ 精灵 | ✅ 精灵 | ✅ 精灵 |
| E2 | 待机呼吸 | `idle` | ✅ | ✅ | ✅ | ✅ |
| E3 | 自播链：东张西望 / 转身（左右镜像）/ 小动作 / 开心 | `look`、`happy`、`play` + 镜像 | ✅ | ✅ | ✅ | ✅ |
| E4 | 点击回应：摸摸 / 开心交替，Q 弹挤压和爱心粒子 | `pat`、`happy` | ✅ | ✅ | ✅ | ✅ |
| E5 | 被拎起（悬空摇晃） | `lifted` | ✅ 用 `pat` 视频 + ❗ | ✅ | ✅ | ✅ |
| E6 | 甩出：重力、撞屏幕边缘反弹、落到屏幕底部 | `lifted` → `pat` | ✅ | ✅ | ✅ | ✅ |
| E7 | 吃白饭 / 吃零食 / 吃水果 | `eat_rice`、`eat_cookie`、`eat_fruit` | ✅ | ✅ | ✅ | ✅ |
| E8 | 玩耍 | `play` | ✅ | ✅ | ✅ | ✅ |
| E9 | 睡觉 | `sleep` | ✅ | ✅ | ✅ | ✅ |
| E10 | 饿了 / 难过 / 开心 | `hungry`、`sad`、`happy` | ✅ | ✅ | ✅ | ✅ |
| E11 | 工作状态：思考中 → 说话，出错时难过；每条消息带时间背景 | `think`、`talk`、`sad` | ✅ | ✅ | ✅ | ✅ |
| E12 | 关系升级演出：进化、闪光、爱心 | `evolve` | ✅ | ✅ | ✅ | ✅ |
| E13 | 角色专属衣柜 | — | 9 套 | 1 套 | 1 套 | 1 套 |
| E14 | 切换角色（保留 agent、聊天记录和好感度） | `hatch` | ✅ | ✅ | ✅ | ✅ |

## 二、使用说明

### 安装

需要 Node.js 20+、桌面环境（Linux 无显示器时用 `xvfb-run`），以及 [LobeHub CLI](https://www.npmjs.com/package/@lobehub/cli)（`lh`）。

```bash
npm install -g @lobehub/cli      # 一次即可；首次唤醒伙伴时应用会引导 lh 登录
git clone https://github.com/rdmclin2/lobehub-pixel-pet-affection.git
cd lobehub-pixel-pet-affection
npm install
```

也可以在 [Releases](https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases) 下载预编译包（macOS / Windows / Linux x64 `tar.gz`）。

### 运行

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

首次启动依次是：18+ 确认（选“只看全年龄”也能用全部模型娘）→ 选择模型娘（四张角色卡，显示厂商和介绍）→ 起名并点“唤醒” → 未登录时按提示完成 `lh` 登录 → 选择 agent 放在哪里（默认个人空间）→ 唤醒演出。之后宠物住在桌面上；鼠标悬停时才显示状态条和按钮。

不连 LobeHub 也能试玩全部效果：`npm test` 用的假 `lh` 可以直接给应用用：

```bash
mkdir -p /tmp/fake-lh && touch /tmp/fake-lh/loggedin
LH_BIN="$PWD/test/fixtures/fake-lh.js" FAKE_LH_DIR=/tmp/fake-lh PIXELPET_DATA_DIR=/tmp/pp-demo npm start
```

假 `lh` 不联网、不创建真实 agent，聊天回复是 `echo: …`；`PIXELPET_DATA_DIR` 让试玩存档和正式存档分开。Linux 上同样可以在末尾加 `-- --no-sandbox`。

### 切换角色

- **首次**：在“选择模型娘”界面点角色卡，再点“唤醒”。
- **之后**：悬停宠物 → ⋯ 菜单 → **高级设置** → “角色”一栏，点想要的角色旁边的 **切换**。LobeHub agent、聊天记录和好感度保留，她的人设在下一句话前更新；身上的服饰新角色没有时换回日常服。切换后会播放唤醒演出。
- **换画风**：⋯ 菜单 → 高级设置 → **外观**，大肥鱼可以在原版动画和像素包之间切换，也可以“导入角色包…”（文件夹或 `.zip`，格式见 [pet-packs.md](pet-packs.md)）。

### 各效果的触发方式

| # | 效果 | 怎么触发 |
| --- | --- | --- |
| E1 | 唤醒演出 | 选好角色点“唤醒”；或在高级设置里切换角色 |
| E2 | 待机呼吸 | 平时什么都不做 |
| E3 | 自播链 | 鼠标离开宠物，每 12–25 秒按权重随机播放一次（东张西望、转身、小动作、开心），不连续重复 |
| E4 | 点击回应 | 单击宠物；连续点击在“摸摸”和“开心”之间交替 |
| E5 | 被拎起 | 按住宠物拖动 |
| E6 | 甩出 | 拖动中快速甩开再松手；慢慢松手只是放下 |
| E7 | 吃东西 | 悬停 → **喂食** → 选白饭 / 零食 / 水果 |
| E8 | 玩耍 | 悬停 → **玩耍** |
| E9 | 睡觉 | 悬停 → **睡觉**；夜里体力低时也会自己睡 |
| E10 | 饿了 / 难过 / 开心 | 随饥饿、心情自动变化（久不喂食会饿，冷落会难过） |
| E11 | 工作状态 | 悬停 → **聊天** 发一句话，或点 **话题**：等回复时“思考中”，回复到达时说话；agent 出错时难过 |
| E12 | 关系升级 | 好感度跨过阶段（15 / 35 / 60 / 85）；⋯ → 高级设置 → **一键解锁** 可以直接加满 |
| E13 | 衣柜 | 悬停 → **衣柜** |
| E14 | 切换角色 | 见上一节 |

## 三、新增一个厂商角色

一个角色 = 一份数据文件 + 一个角色包，**不需要改应用代码**。第四位角色杰米（Gemini 娘，`src/characters/gemini.json` + `src/renderer/packs/gemini-pixel/`）就是按下面的步骤加进来的，可以直接对照。下面以再新增一位 “Kimi 娘”（id `kimi`）为例。

1. **准备美术（角色包）**：新建 `src/renderer/packs/kimi-pixel/`，内含 `pack.json` 和 `sheets/daily.png`。
   - 最快的做法是复制一个现有像素包，改 `pack.json` 的 `id`（`kimi-pixel`）、`name`、`author`、`license`、`description`，并把 `species` 改成 `kimi`。
   - 自己画：按 [pet-packs.md](pet-packs.md) 的 schema 2，精灵图 332×904（4 列 × 8 行，每帧 83×113），动作名就是状态名，只有 `idle` 必填，缺的状态按回落链降级。本仓库的生成管线：`python3 scripts/art/model_chan_prompts.py` 出提示词 → `lh generate image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"` → `scripts/art/slice_sheet.py` → `scripts/art/fit_cells.py`（紫色系发色加 `--keep-violet`，否则发色会被去品红边洗成灰色）→ `scripts/art/build_model_chan_pack.py` → `scripts/art/check_model_chan.py` 校验（参数见 [art/model-chan/README.md](../art/model-chan/README.md)）。
2. **写数据文件** `src/characters/kimi.json`，照着 `src/characters/claude.json` 填：

   ```jsonc
   {
     "id": "kimi",                 // 2–20 位 a-z0-9，字母开头；文件名必须是 <id>.json
     "order": 5,                     // 角色卡排序
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
     "credits": ["设定：…（许可）", "像素图：…（许可）"]
   }
   ```

   字段由 `src/core/species.js` 的 `validateCharacter` 校验，缺字段或格式不对时应用启动会报出具体原因。视频角色用 `"art": { "kind": "video", "dir": "assets/<id>", "clips": { "idle": "idle.webm", … }, "packs": [] }`，参考 `src/characters/dafeiyu.json`。
3. **写清授权**：在 `credits`、`pack.json` 的 `license` / `author` 和 [NOTICE.md](../NOTICE.md) 写明素材来源与许可；所有角色都必须是成年人，不得有裸露或露骨内容（[pet-packs.md](pet-packs.md#内容要求)）。`personality` 必须写明“成年角色，设定年龄 25 岁以上”；角色文件里不能出现“少女、少年、萝莉、宝宝、校服、孵化”等幼态或成长用词（`test/compliance.test.js` 会逐行检查，写“姑娘”而不是“少女”）。
4. **运行确认**：`npm start`，选择模型娘界面会多出一张 Kimi 卡片，唤醒后所有效果自动可用。
5. **更新测试**：下面几处固定了现有角色，把新角色加进去，再跑 `npm test` 和 `xvfb-run -a node e2e/run.js roster kimi`：
   - `test/characters.test.js`：角色 id 列表和厂商列表；
   - `test/dafeiyu.test.js`：角色 id 列表；
   - `test/packs.test.js`：内置角色包 id 列表（加 `kimi-pixel`）和逐角色检查的 id 列表；
   - `e2e/run.js` 的 `ROSTER`：加一行 `{ id: 'kimi', idx: 4, zh: '琪米', vendor: 'Moonshot' }`（`idx` 是角色卡的位置，从 0 开始）；
   - `test/outfits.test.js`：逐角色衣柜检查的 id 列表和招牌服饰名；
   - `e2e/run.js` 里角色卡数量（`.char-card` 的 `count()`，三处）、厂商列表（`vendors`）、`art` 总表的像素包列表，以及导入非法角色包时报错信息里的角色 id 列表；
   - `docs/pet-packs.md` 的 `species` 注释。
6. 在本文档的角色清单里加一行。

## 四、验证

- `npm test`：单元测试（假 `lh`，不联网），包括角色文件和角色包的校验。
- `xvfb-run -a node e2e/run.js roster`：逐个角色选择、唤醒，逐项触发 E1–E14，截图在 `out/e2e/`，录屏在 `out/e2e/roster-video/<角色>/`；`... roster claude` 只跑一个角色。
- `xvfb-run -a node e2e/run.js art`：输出“每个角色 × 每个状态”总表 `out/e2e/state-sheet.png`。
