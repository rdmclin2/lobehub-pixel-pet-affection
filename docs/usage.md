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
npm run start:no-sandbox          # 等同于 npm start -- --no-sandbox
```

没有显示器的 Linux（服务器、CI）用 `xvfb-run` 包一层：`xvfb-run -a npm run start:no-sandbox`。

**不连 LobeHub 试玩**：单元测试用的假 `lh` 可以直接给应用用，全部效果都能玩：

```bash
mkdir -p /tmp/fake-lh && touch /tmp/fake-lh/loggedin
LH_BIN="$PWD/test/fixtures/fake-lh.js" FAKE_LH_DIR=/tmp/fake-lh PIXELPET_DATA_DIR=/tmp/pp-demo npm start
```

假 `lh` 不联网、不创建真实 agent，聊天回复是 `echo: …`；`PIXELPET_DATA_DIR` 让试玩存档和正式存档分开。Linux 上同样可以在末尾加 `-- --no-sandbox`。

**一条命令直接看到桌宠**：`npm run demo` 用同一个假 `lh` 在 `<系统临时目录>/pixel-pet-demo` 里准备好试玩存档（18+ 已按“只看全年龄”回答、已唤醒克洛蒂），然后启动应用，宠物直接出现在屏幕右下角，不用走首次启动流程。唤醒走的是应用自己的 `PetService.hatch`，和点“唤醒”按钮是同一段代码。

```bash
npm run demo                                   # 有桌面时
xvfb-run -a npm run demo                       # Linux 无显示器
npm run demo -- --character gpt --name 小杰    # 换角色 / 起名（claude、gpt、grok、gemini、dafeiyu）
npm run demo -- --fresh                        # 清掉试玩存档重新唤醒
```

Linux 上 `npm run demo` 自动带 `--no-sandbox`（原因见上）；`npm start` 不变。代码：`scripts/demo.js`。

其他环境变量：`PIXELPET_NO_UPDATE=1` 关闭自动更新；`PIXELPET_NO_CONNECT=1` 禁止启动 `lh connect`。

数据位置：系统用户数据目录下的 `pet.json`（宠物、好感度、服饰）和 `settings.json`（18+ 回答、设置开关、同屏伙伴、对外接口）。Linux 为 `~/.config/Pixel Pet Affection/`，macOS 为 `~/Library/Application Support/Pixel Pet Affection/`。

## 三、首次启动与连接 LobeHub

1. **18+ 确认**：“我已年满 18 岁”或“未满 18 岁 / 只看全年龄内容”。选后者也能用全部模型娘，她们本来就只有全年龄内容。
2. **选择你的模型娘**：五张角色卡（大肥鱼 / 克洛蒂 / 格萝可 / 杰米 / 吉皮缇），显示厂商和介绍；点一张，下方显示她的说明。
3. **本机能力**（默认勾选）：“让它能使用这台电脑”。勾选后，能读到 `lh login` 的登录（或设置了 `LOBEHUB_CLI_API_KEY`）时，这类对话直接走 LobeHub Responses API，读写文件、列目录、运行命令这几个工具由应用在本机执行，不需要连接设备，开启和每一步工具调用都更快；读不到登录或直连失败时，才退回到确保 `lh connect --daemon` 在运行、把 agent 绑定到这台电脑的老办法。它能碰到你账号权限内的所有文件和命令，不是沙盒；之后可以在 ⚙ 设置 → LobeHub 与本机 →“本机能力”随时关闭。
4. 起名（可选），点 **唤醒**。进度依次是：
   - 检查 LobeHub 登录（`lh whoami`）；
   - 未登录时在浏览器里登录 LobeHub：应用打开登录页，并显示要确认的验证码（`lh login` 设备码登录）；
   - **把它放在哪里？** 默认个人空间；也可以选你加入的 workspace（那里的成员可能看得到它），之后所有调用固定在这个空间；
   - 创建她的 LobeHub agent（`lh agent create`，人设写进 agent 的系统设定）；
   - 连接这台电脑（勾选了本机能力时）；
   - 醒来：播放唤醒演出。
5. 之后宠物住在桌面上，平时只有她和对话气泡。**右键她**（触屏上长按 0.5 秒）在她身边弹出 **她的面板**：她的状态，以及喂食、玩耍、睡觉、聊天，🔈 静音、⚙ 设置、⏻ 退出（点一下直接关掉应用，存档已随时保存，下次打开她还在），见下面的「她的面板」。聊天、话题和主动说话通过 `lh agent run` 调她的 agent，每轮复用同一个 LobeHub 话题，所以长期记忆在 LobeHub 里。

### 她的面板（右键她）

她的状态和能对她做的事，放在她旁边的一张卡片里（独立的小窗口，不挡住她）。

- **打开**：鼠标右键她；触屏上按住她 0.5 秒不动。面板出现在她右边，底部和她的脚对齐；她靠屏幕右边时出现在她左边，始终留在屏幕内。她走动时面板跟着她。
- **关闭**：Esc；点面板以外的任何地方（包括点她的窗口、切到别的应用）；再右键她一次；点了会让她做事的按钮之后；她开始思考时。
- **面板内容**（从上到下）：
  - 她的名字、角色（如「大肥鱼 · Live2D」）和好感阶段标签；
  - 好感条和数值（`86/100`），下面一行是“距「下一阶段」还差 N · 今天 +x/上限”，满级时是“已满级”；
  - 三项状态：饱腹、心情、体力，各有数值和细条（绿 / 黄 / 红表示好坏）；
  - 四个操作：**喂食**（在面板里展开食物，点一种就喂）、**玩耍**、**睡觉**、**聊天**（关掉面板，打开聊天输入框）；
  - 底栏：🔈 **静音**（原地切换，面板不关）、⌂ **小游戏**（和她一起玩上次玩的小游戏，见下一节）；VRM 外观时多出 ♪ **跳舞**、↺ **重置姿势**；右边是 ⚙ **设置**（有新内容时带小红点）和 ⏻ **退出**。
- **键盘**：面板打开后可直接用 ← → ↑ ↓ 在按钮间移动，回车 / 空格按下，Esc 先收起食物、再关闭面板。
- 悬停她不再显示状态条和工具栏；悬停时只保留调整大小的手柄和打开着的聊天框。

### 小游戏（商店里下载，和她一起玩）

小游戏是商店里可以下载的场景，第一款是「像素小院」：一座漂在空中的等距像素小院。她在院子里自己逛，你点哪她走到哪；她会坐长椅、浇菜收菜、摘浆果、开关路灯、夜里抓萤火虫。画面下方的「天色」卡片可以切换清晨 / 白天 / 黄昏 / 夜晚（也能拖滑块连续调，或打开「随时间流动」，一天 24 分钟），还能切换晴朗 / 多云 / 小雨 / 雷雨 / 下雪 / 起雾。每天有三件「今日小事」，做完一件加好感（每天最多三次）。

- **下载**：⚙ 设置 → 商店 → **小游戏** → 下载，下载好点「开始玩」。卡片上的「开源仓库」是这个游戏的源码。
- **更新**：有新版本时卡片显示「有更新」和更新说明，点「更新到 vX」；游戏窗口标题栏也会提示「有新版本」。「检查更新」立即检查一次。进度会保留。
- **打开**：托盘「小游戏」、面板底栏 ⌂、桌宠窗口里按 `Ctrl/⌘ + Shift + H`，打开的是上次玩的那个；还没下载过时会打开商店。打开时桌面上的她隐藏。
- **操作**：点空地让她走过去；点物件让她去用（悬停时有提示）；点她摸摸，按住拖动拎起她；拖动画面平移，滚轮或工具栏 ＋ － 缩放，⌖ 让镜头跟着她。
- **关闭**：右上角 ✕、`Ctrl/⌘ + W` 或再按 `Ctrl/⌘ + Shift + H`；她回到桌面原位。时段、天气、菜地和今日小事都会保存。
- 详细玩法、实现、怎么做新的小游戏包和验证，见 [`mini-games.md`](mini-games.md)。

### 检查更新（macOS 顶栏菜单）

- **macOS**：顶栏 **Pixel Pet** 菜单 → **检查更新…**（在「关于 Pixel Pet」下面）。**其他系统**：托盘图标 → **检查更新**。两处走的是同一个检查，和 ⚙ 设置 → 版本与更新 里的“检查更新”一样。
- 结果用系统对话框告诉你：
  - **已是最新版本**：显示当前版本号；
  - **发现新版本 vX**：可以自动更新的版本在后台下载，下载好后再弹一次「新版本 vX 已下载好」，可以点 **立即更新**（重启约 2 秒，数据都保留）或 **稍后**；需要手动安装的版本给出 **前往下载页**；
  - **检查更新失败**：显示原因（如网络错误、HTTP 500），可以点 **重试**；
  - **当前版本不检查更新**：从源码运行的开发版或关闭了更新时。

### macOS 的权限弹窗（为什么会问我要权限）

桌宠自己只会在你第一次点 🎤 时请求麦克风；它不会主动读“下载”/“桌面”/“文稿”。你看到的其他弹窗来自下面几种情况：

- **她用本机能力读写文件、跑命令时**：工具在应用里执行，或者在应用启动的 `lh connect` 里执行，macOS 会以 Pixel Pet Affection 的名义询问这些文件夹。不想让她碰这台电脑，就在 ⚙ 设置 → LobeHub 与本机 关掉“本机能力”。
- **每次更新之后又问一遍**：旧版本用 ad-hoc 签名，系统按每个版本的代码哈希记授权，新版本就被当成新的应用重新询问。现在发布包改用项目固定的自签名证书签名，授权按证书记住，更新后不再重新询问；从旧版本升级上来时会最后再问一次。
- **应用放在“下载”/“桌面”/“文稿”里**：放在这几个文件夹里时它不会自己更新（旧版本会把更新解压到应用旁边，于是反复弹窗），只会提示你先挪到“应用程序”。
- **找 `lh` 时**：`lh` 不在常见目录里时，应用会通过你的登录 shell（`~/.zshrc`）查一次，查到的路径会记住，以后不再执行 shell 配置。

⚙ 设置 → 数据与关于 里的“放生并删除 agent”会删除宠物和每位角色的 LobeHub agent；“仅重置本地”只清本地存档（都会再确认一次）。

## 四、选角与切换角色

- **首次**：在“选择你的模型娘”界面点角色卡，再点“唤醒”。
- **之后切换**：⚙ 设置 → **角色**（角色图鉴）。每位角色都有自己的 LobeHub agent（自己的人设、模型、聊天记录）、名字、好感度和需求值（饥饿 / 心情 / 精力 / 睡眠），列表里每行有她的缩略图（当前角色包、穿着的服饰）、名字（你起的名字 + 中文名 + 厂商）、称号，以及“已认识 · 阶段 · 好感 X”或“未见过”。
  - **角色详情**：点列表里的一行（或“设置 ›”）打开她的页面，没见过的角色也能打开；页面顶部“‹ 角色列表”返回。这里有她的**外观（角色包）**和**好感度 · 一键解锁**；**模型**和**个性化设定（System Role）**显示当前值，点“在设置窗口中编辑 ›”到设置窗口里改（设置窗口的角色详情页也有外观和好感度）。这些都只作用于她，不影响当前陪伴的角色。“切换 / 初次见面”在列表和她的页面里都能点。
  - **初次见面**：点没见过的角色旁边的 **初次见面**，给她起个名字（可选，最多 12 个字，默认用她自己的名字）→ **请她来**。应用在你唤醒时选的空间里为她新建 agent（标题 `名字 (英文名)`），这时气泡和面板显示“她正在赶来…”；她从陌生开始，跟你打招呼。新建失败（网络、登录过期、`lh` 被固定在别的 workspace）时留在原角色，什么都不保存，可以再试。
  - **见过的角色**：点 **切换**，她的 agent、聊天记录、名字、好感度和服饰都还在，用一句离线台词打招呼。不在屏幕上的角色需求值暂停，离开的时间也不算冷落她（不掉好感）。
  - 切换后播放唤醒演出。开着“使用本机”时，新角色的 agent 也会绑定到这台电脑；关掉时解绑所有角色的 agent。
- **换画风 = 换角色**：没有“形象包”可选了，每个形象都是一位独立角色。⚙ 设置 → **角色**（角色图鉴）里，「克洛蒂 · 像素」（默认的高清像素，每帧 664×904，平滑绘制）和「克洛蒂 · 旧版像素」（v0.7.0 及以前那套 83×113、更 Q 的像素图）是两张卡；大肥鱼还有「大肥鱼 · Live2D」「大肥鱼 · 全动态」「大肥鱼 · 原版动画」（dsh-pet 透明视频）。点 **切换** 即换；同一位模型娘的各个形象共享 agent、聊天记录、名字和好感，衣柜、取景和 VRM 姿势各自独立（当前角色存在 `pet.json` 的 `characterId`）。也可以“导入角色…”（文件夹或 `.zip`，格式见 [pet-packs.md](pet-packs.md)）成为新角色。老版本存在 `settings.json` 的 `appearance` 里的选择会在升级时自动迁移，见 [characters.md · 数据迁移方式](characters.md#数据迁移方式srccorecharacter-migratejst-2764--t-2786)。
- **个性化设定**：设置窗口 → **角色列表** → 她 → **个性化设定**。写几句给她的额外设定（怎么称呼你、说话风格、要记住的事，最多 1000 字），点“保存”；它会加进她 agent 的 system role（“主人给你的个性化设定”一段），只对她生效，关系阶段和内容红线仍然优先。给当前角色保存后立即更新她的 agent；给别的角色写的，等她下次陪你时（或初次见面新建 agent 时）用上。“清空”确认后删掉，她回到默认性格。存在 `settings.json` 的 `systemRoles`。
- **换模型**：设置窗口 → **角色列表** → 她 → **模型**（模型跟着角色走）。下拉框里只有她自家厂商的模型：大肥鱼 DeepSeek、克洛蒂 Claude、格萝可 Grok、杰米 Gemini、吉皮缇 GPT（含 o 系列）。列表来自你在 LobeHub 里启用的模型：LobeHub 托管的排在前面；如果你还启用了该厂商自己的服务商（填了自己的 Key），那些模型也会列出，标“（自己的 … Key）”。只能出图的模型（如 Nano Banana）不列。没选过时用角色的默认模型（标“默认”）：大肥鱼 DeepSeek V4.1 Flash、克洛蒂 Claude Sonnet 5.5、格萝可 Grok 4.7、杰米 Gemini 3.8 Flash、吉皮缇 GPT-6 Luna；默认模型没启用时用列表第一个。给当前角色选好后立即改 agent 的模型；给别的角色选的，等她下次陪你时（下一句话起）换上；换角色后，下一句话起换成新角色的模型，每位角色各自记住你的选择（存在 `settings.json` 的 `models`）。模型列表 10 分钟内复用，点“刷新”立即重读；`lh` 读不到列表（版本太旧或离线）时她继续用原来的模型。
- **请别的模型娘来串门**：设置窗口 → **同屏伙伴**，见下面的 E24。

## 五、各效果的触发方式

效果层（`src/core/fx.js` + `src/renderer/fx.js`）移植自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，**五位角色全部支持**，角色之间只差配置、素材和台词。角色缺某个状态的素材时按回落链降级（例如“吃水果”→“吃饭”→“开心”→“待机”）并叠加表情符号。E15–E26 是与 dsh-pet 逐项对照后补上的（T-1163），对照表见 [dsh-pet-gap.md](dsh-pet-gap.md)。

| # | 效果 | 状态 / 动作 | 怎么触发 | 设置开关 |
| --- | --- | --- | --- | --- |
| E1 | 唤醒演出 | `hatch` | 选好角色点“唤醒”；或在 ⚙ 设置 → 角色里换角色 | 无，始终可用 |
| E2 | 待机呼吸 | `idle` | 平时什么都不做 | 无，始终可用 |
| E3 | 自播链：东张西望 / 转身（左右镜像）/ 小动作 / 开心 | `look`、`happy`、`play` + 镜像 | 鼠标离开宠物，每 12–25 秒按权重随机播放一次，不连续重复 | 无，始终可用 |
| E4 | 点击回应：摸摸 / 开心交替，Q 弹挤压和爱心粒子 | `pat`、`happy` | 单击宠物；大肥鱼在 4 段摸摸、2 段开心视频里轮换 | 无，始终可用 |
| E5 | 被拎起（悬空摇晃） | `lifted` | 按住宠物拖动 | 无，始终可用 |
| E6 | 甩出：重力、撞屏幕边缘反弹、落到屏幕底部 | `lifted` → `pat` | 拖动中快速甩开再松手；慢慢松手只是放下 | 无，始终可用 |
| E7 | 吃白饭 / 吃零食 / 吃水果 | `eat_rice`、`eat_cookie`、`eat_fruit` | 右键她 → **喂食** → 选一种 | 无，始终可用 |
| E8 | 玩耍 | `play` | 右键她 → **玩耍** | 无，始终可用 |
| E9 | 睡觉 | `sleep` | 右键她 → **睡觉**；夜里体力低时也会自己睡 | 无，始终可用 |
| E10 | 饿了 / 难过 / 开心 | `hungry`、`sad`、`happy` | 随饥饿、心情自动变化（久不喂食会饿，冷落会难过） | 无，始终可用 |
| E11 | 工作状态：思考中 → 说话，出错时难过；每条消息带时间背景 | `think`、`talk`、`sad` | 右键她 → **聊天** 发一句话，或点 **话题**：等回复时“思考中”，回复到达时说话；agent 出错时难过。工作中悬停只显示 **■ 停止**，按 Esc 也能中断 | 无，始终可用 |
| E12 | 关系升级演出：进化、闪光、爱心 | `evolve` | 好感度跨过阶段（15 / 35 / 60 / 85）；角色列表 → 当前角色 → **一键解锁** 直接加满 | 无，始终可用 |
| E13 | 角色专属衣柜 | — | 悬停 → **衣柜**（每位角色 1 套原设服装 + 12 套按好感阶段解锁的全年龄服饰；外观选 18+ 成年版时是成年版日常服 + 11 套成人向服饰） | 无，始终可用 |
| E14 | 切换角色（每位角色各自的 agent、聊天记录、名字和好感度） | `hatch` | 见第四节 | 无，始终可用 |
| E15 | 自己走动（漫游） | `walk` | 鼠标离开、她不忙、没开面板时偶尔朝面向的方向走 60–240 像素，到屏幕边掉头。大肥鱼播 dsh-pet 的螃蟹走路，像素角色用待机帧颠步 + 👣。开关：桌宠行为 →“自己走动” | 桌宠行为 →“自己走动”（默认开） |
| E16 | 触屏长按 / 右键打开她的面板 | — | 触屏上按住她 0.5 秒不动；或鼠标右键她 | 无，始终可用 |
| E17 | 动作点播、回到右下角 | 任意状态 | ⚙ 设置 → 玩法 → **桌面上的她** → 动作（东张西望、转身、走两步、开心、害羞、玩耍、想事情、委屈、闪亮登场）；同页 **回到右下角** | 无，始终可用 |
| E18 | 弹弓 | `lifted` → `pat` | 0.3 秒内连按两下，第二下按住往反方向拉（至少 20 像素），松手后朝反方向弹出，力度只看拉多远 | 无，始终可用 |
| E19 | 空中接住得分 | `happy` | 甩出后在她飞行时点中她（速度 ≥ 400 px/s 才计分），弹出“+N”和火花，越快、宠物越小分越高 | 无，始终可用 |
| E20 | 落地挤压随冲击加深 | — | 甩得越猛，落地压得越扁（300 px/s 压到 0.8，1500 px/s 以上压到 0.55） | 无，始终可用 |
| E21 | 点击音效 | — | 桌宠行为 →“点击音效”（默认关）；点她时“啵”一声，100 毫秒内连点只响一次 | 桌宠行为 →“点击音效”（默认关） |
| E22 | 梗图贴纸 | — | 桌宠行为 →“梗图”（默认开）。agent 回复时自己挑一张（每条消息附带她的梗图清单）；饿了 / 无聊 / 问候等离线碎碎念随机配图。大肥鱼 9 张，其他角色各 4 张 | 桌宠行为 →“梗图”（默认开） |
| E23 | 语音（TTS）：对话语音 + 互动语音 | — | 桌宠行为 →“朗读回复”（总开关，默认关）。开启后：**对话语音**——agent 的回复、话题和对外接口发来的话整段按句朗读，正在读的句子在气泡里高亮，主人发新消息立即停；**互动语音**（“互动语音”，默认开）——初次见面、摸摸、部位触摸、喂食、玩耍、哄睡、拖拽、甩出、接住、关系升级、切换角色念出她气泡里的那句，连点不排队、1.5 秒内只说一句；**碎碎念**（“朗读碎碎念”，默认关）。引擎在 设置窗口 → 朗读 选：按角色（默认：大肥鱼用 MiniMax，其他角色用 Fish Audio）、Fish Audio、MiniMax、ElevenLabs（云端引擎需 API Key）、系统语音（离线免费）；每位角色有自己的音色。云端用不了（没 Key、断网、4 秒超时、出错）时这句改用系统语音或不出声。详见下方“语音（TTS）” | 桌宠行为 →“朗读回复”（默认关）、“互动语音”（默认开）、“朗读碎碎念”（默认关） |
| E24 | 同屏伙伴（最多 3 位） | 全部 | 设置窗口 → **同屏伙伴** 勾选角色，她们出现在桌面上（没有 agent），一起走动、被点、被甩；悬停伙伴点 × 送她回去 | 同屏伙伴：勾选即开，不勾即无（默认无） |
| E25 | 互相碰撞 | `lifted` | 有同屏伙伴时把她甩向伙伴，撞到的伙伴被弹开。开关：桌宠行为 →“互相碰撞”（默认开） | 桌宠行为 →“互相碰撞”（默认开） |
| E26 | 本机 HTTP 接口 | 任意状态 | 设置窗口 → **对外接口** 勾选开启（默认关），只监听 `127.0.0.1:7340`，每次调用都要带设置里显示的令牌，见下文 | 对外接口：“开启对外接口”（默认关） |

E26 的接口：

```bash
TOKEN=<设置窗口 → 对外接口里复制的令牌>
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7340/pixel-pet/state                       # 读状态
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"你好"}' http://127.0.0.1:7340/pixel-pet/say                                       # 说一句话（不调模型）
# POST /pixel-pet/anim  {"state":"walk","facing":"left"}   播动作（共享状态加 turn）
# POST /pixel-pet/throw {"angle":60,"power":1.2}           抛出去（0°=向右，90°=向上，power 0.2–3）
# POST /pixel-pet/chat  {"text":"…"}                       和她的 agent 聊一句并等回复（会调用模型）
# POST /pixel-pet/reset-pose                               重置姿势：停下一切动作回到待机（见下文「重置姿势」）
# GET  /pixel-pet/motions                                  VRM 角色现在能播的动作片段（动作库，按她的风格回退后）
# POST /pixel-pet/motion {"group":"bow"}                    播一个动作片段：id（idle.v03@female）/ slot（react.nod-01）/ group（nod、bow、stretch、sit…）任选其一，"loop":true 循环
# POST /pixel-pet/motion/stop                               停下手动播放的动作，平滑回到待机
```

### VRM 动作库与动作试播（T-5084）

VRM 角色（包括从商店下载的）的姿势、待机、反应、说话和走路动作都来自**动作库**——烘焙好的 `.vrma` 片段和它的 `library.json`（[vrm-motion-library.md](vrm-motion-library.md)）。动作库不在安装包里，也不进仓库：

- **找动作库的顺序**：环境变量 `PIXELPET_VRM_MOTIONS_DIR` → 你在设置里选的文件夹 → 应用数据目录下的 `vrm-motions`（`node scripts/vrm-bake.js --v2 --install` 装到这里）→ 开发运行时的 `~/vrm-assets/baked-v2`、`~/vrm-assets/baked`。
- **没有动作库时**：她只能站着呼吸、看看四周。桌宠气泡会说一次「我还没有动作库……」，日志里有 `[vrm] no motion library (looked in: …)`，⚙ 设置 → **角色** → 她的页 → **装扮** → **VRM 动作库** 显示黄色提示。
- **选择动作库文件夹**：同一处点「选择动作库文件夹」，选烘焙输出的文件夹（含 `library.json`，例如 `~/vrm-assets/baked-v2`；选它的上一级也行）。不会复制任何文件，只记下位置；她立刻按新动作库重新载入。「取消关联」恢复默认顺序。
- **动作试播**：当前角色是 VRM 时，同一卡片里选一个动作（按姿势 / 待机 / 反应 / 情绪 / 说话 / 行走分组）点「播放」；「停止」或播完后她平滑回到待机。聊天里说「点个头」「鞠个躬」「伸个懒腰」「坐下」「躺下」也会播对应动作（「站起来」「别做了」停下），本地 API 见上面的 `/motion`。
- **风格**：角色包没写 `vrm.style` 时按模型推断——胸部 SpringBone → 女性，裙摆 SpringBone 且肩窄 → 女性，肩宽 ≥ 1.55 × 髋宽 → 男性，其余 neutral（有自己的一套动作，缺的按 neutral → female → male 回退）。

### 语音输入（ASR）

设置窗口 → **语音输入** 打开后，聊天框旁的 🎤 把你说的话转成文字填进输入框。两种识别方式（复用 LobeHub 云端识别，或本机跑 whisper.cpp / speaches 等本地服务）的安装、配置、测试连接和故障排查见 [asr.md](asr.md)。

**快捷键唤起语音对话**：在任何地方按 **Ctrl+Shift+Space**（macOS **⌘⇧Space**），她出现在桌面上并开始听，说完再按一次结束并识别。在 设置 → 语音输入 → 快捷键 里修改、清空或恢复默认；无效、和应用内快捷键冲突或被其他应用占用的组合会在字段下方提示且不保存。详见 [asr.md §1.1](asr.md#11-快捷键唤起语音对话)。

### 语音（TTS）

1. **打开**：右键她 → 面板 ⚙ 设置 → 设置 → **朗读** → 打开 **朗读回复**。关着时什么都不念，也不请求任何语音服务。
2. **选引擎**：设置窗口 → 朗读 →“引擎”。

   | 引擎 | 需要 | 说明 |
   |---|---|---|
   | 按角色（默认） | 她的引擎的 Key | 大肥鱼用 MiniMax「俏皮萌妹」（`qiaopi_mengmei`），其他角色用 Fish Audio；她的引擎没 Key 或出错时换另一个有 Key 的引擎（大肥鱼 → Fish「蓝色大肥鱼」） |
   | Fish Audio | API Key（[fish.audio](https://fish.audio) → API Keys） | 所有角色都用 Fish：模型 `s2.1-pro`，每位角色一个社区音色；免费账号限个人非商业使用 |
   | MiniMax | MiniMax 接口密钥（API Key，[platform.minimaxi.com](https://platform.minimaxi.com) 国内站 → 账户管理 → 接口密钥；不用填 GroupId） | 所有角色都用 MiniMax：`speech-2.8-turbo` + 平台系统音色。默认端点是国内站 `https://api.minimax.cn`；国际站（minimax.io）的 Key 要把端点改成 `https://api.minimax.io` |
   | ElevenLabs | API Key（[elevenlabs.io](https://elevenlabs.io) → Profile → API Keys）+ 音色 `voice_id`（必填） | 所有角色都用 ElevenLabs（`POST /v1/text-to-speech/{voice_id}`，Key 在 `xi-api-key` 请求头）。`voice_id` 从 Voice Library / My Voices 复制，填在 ElevenLabs 卡片的 **默认音色 ID** 或角色文件 `voice.tts.elevenlabs.voiceId`（角色优先）；**模型** 可选，默认 `eleven_multilingual_v2`；**端点** 可选，留空用 `https://api.elevenlabs.io`。没填 Key 时卡片显示「未设置 Key」，选了它会提示先填 Key |
   | 本地语音服务（自己部署） | 你自己跑的语音服务的地址（Key 可不填） | IndexTTS2 / GPT-SoVITS / whale-voice 等跑在本机或局域网电脑上，音色由你的服务决定；接口选 OpenAI 兼容（`/v1/audio/speech`）或 whale-voice（`/tts`）。只在选它时用，不当云端引擎的备用；等待时间是云端的 4 倍（20 秒，长句最多 40 秒）。详见 [README](../README.md#语音tts) “本地语音服务” |
   | 系统语音 | 无 | 操作系统自带语音，离线免费；Linux 需装 speech-dispatcher 和中文语音包 |

   LobeHub 账号**不能**代为合成 MiniMax 语音（`lh gen tts` 只走 OpenAI 接口、云端返回 404；LobeHub 的 MiniMax provider 没有语音模型），大肥鱼的 MiniMax 音色要填你自己的 MiniMax Key。

3. **配置 API Key**：在对应引擎下粘贴 Key → **保存**。Key 只存在本机 `userData/tts-keys.json`（只有当前用户可读；macOS 不用钥匙串，免得每次更新都弹密码框），保存后输入框清空、只显示“已设置”，不进 `settings.json` 和日志。端点一般留空；自建代理可填 `https://…`。点 **试听一句** 听当前角色的口头禅。
4. **角色音色**：不用选，跟着当前角色走（大肥鱼 MiniMax「俏皮萌妹」/ Fish「蓝色大肥鱼」、克洛蒂「温柔动听女声」、格萝可「御姐」、杰米「可爱小猫娘」、吉皮缇「温柔叙事女声」；MiniMax 各有对应系统音色），换角色后自动换音色。完整表见 [README](../README.md#角色音色)。
5. **对话语音**：她的回复不截断，按句号 / 问号 / 感叹号 / 分号 / 换行切句，一句一句合成播放（播这句时预取下一句）；气泡显示整段，正在读的那句高亮。主人发新消息、开新话题、关掉朗读回复时立即停下。表情、括号舞台说明、链接、梗图标签不念；一段最多念 30 句。
6. **互动语音**（默认开）：互动的那句台词用她的音色念出来；她常说的短句会在后台预先合成缓存，点了马上响。上一句没说完或 1.5 秒内的互动台词直接丢掉（气泡照常更新），互动不会打断正在读的回复。**朗读碎碎念** 打开后，她自己冒出来的话（饿了、无聊、问候…）也念。
7. **回退**：没填 Key、断网、5 秒没响应（长句最多 10 秒）、服务返回错误时，这一句按“用不了时”改用 **系统语音**（默认）或 **不出声**。出错的引擎暂停一会儿再试：超时、断网、服务端出错 20 秒，被限流 20 秒，Key 无效、余额不足 5 分钟（改 Key / 端点 / 引擎立刻重试）。
8. **限流**：MiniMax 国内站语音合成每分钟只能请求 10 次（免费账户；充值后 20 次），桌宠自己按这个数控制请求：这一分钟用完了：几秒内就有空位的话，这一句稍等一下再用她的声音说；要等更久就按“用不了时”处理，不会去撞限流。预合成只用多出来的次数，给你正在说的话留 3 次。语音面板里能看到这一分钟还剩几次。合成过的句子缓存在本机（50MB），再说同一句不再请求。
9. **语音包**（默认开）：5 位角色都自带一个用 MiniMax 系统音色录好的语音包（`src/voicepacks/<角色>/`），收录她所有固定台词（摸头、喂食、玩耍、部位触摸、拖拽 / 甩出 / 接住、关系阶段台词、碎碎念、回退台词，每位约 220 句）。这些台词直接播放录音：不联网、不用 Key、不占 MiniMax 每分钟次数、没有等待。她的回复不是固定台词，仍由引擎合成。为了声音一致，引擎选了别家并且能用时（比如填了 Key 的 Fish Audio），不用这个 MiniMax 语音包；选“系统语音”或关掉“语音包”时也不用；一个 Key 都没填时，录好的台词照样用语音包念。
10. **自己的语音包**：点 **打开语音包文件夹**（`userData/voicepacks/`），放进一个文件夹（`manifest.json` + 音频），再点 **重新读取**；同一角色以你的为准。格式：
   ```json
   { "format": 1, "id": "my-dafeiyu", "name": "我录的大肥鱼", "character": "dafeiyu",
     "engine": "minimax", "credit": "…",
     "lines": { "摸头……嗯，凑合。": "a1.mp3", "咕噜": "a2.mp3" } }
   ```
   `lines` 的键是这句念出来的文字（去掉表情、括号里的动作、链接后的样子）；`engine` 写录音所用的引擎（手工录音可以不写，此时总是使用）。要用哪些台词，可以照 `node -e "console.log(require('./src/core/voice-pack').packLines(require('./src/core/species').SPECIES.dafeiyu))"` 列出来。
11. **重新生成内置语音包**：台词改了以后运行 `node scripts/voicepack-generate.js [--only dafeiyu]`。Key 从 `MINIMAX_API_KEY` 环境变量读，或者从 `~/.config/pixel-pet/minimax.env`、`~/.zshrc`、`~/.bashrc` 里的 `export MINIMAX_API_KEY=…` 读，脚本不会打印 Key。已录的句子会跳过，台词表里已经没有的句子会删掉；按每分钟 10 次节流，一个角色约 25 分钟。
12. **风格语音包（商店下载）**：设置窗口 → **商店 → 语音包** 有 5 个用 MiniMax 录制的风格包：可爱（甜心少女，女）、御姐（妩媚姐姐，女）、少年（纯真学弟，男）、沉稳（可靠前辈，男）、搞笑（幽默大爷，男）。每个包 138 句通用台词，任何角色都能用。
   - **试听**不用下载；点 **下载** 后卡片依次显示「未下载 → 下载中（进度条、取消）→ 已下载」。归档按 sha256 校验，校验不通过就丢弃。
   - 下载好的包在商店的「已下载」筛选和 **设置 → 语音包** 表格（来源「商店下载」）里，文件在 `userData/voicepacks/<id>/`。
   - **给角色选**：设置窗口 → 角色 → 她 → **语音** → **语音包**，可以选「不使用」「内置（自动）」或已下载的风格包，选中后下一句就生效，重启后保持（`settings.json` 的 `tts.voicePackByCharacter`）。没下载的包灰掉，点「去商店下载」去商店。所有角色统一用一个包时，在 设置 → 语音包 → **我的语音包** 选。
   - **删除**：在商店卡片上点 删除。正在用它的角色回到内置，重新下载后自动恢复。
   - **生成 / 新增风格**：`MINIMAX_API_KEY=… node scripts/voicepack-generate.js --style [cute,yujie]` 录音（每分钟 10 次，可断点续录，需要 ffmpeg 转成 Opus），`node scripts/build-voice-catalog.js` 打包并更新商店目录，`node scripts/upload-character-catalog.js --voices` 上传到 CDN。完整步骤见 [voice-packs.md §6–§9](voice-packs.md)。
13. **隐私与授权**：开云端引擎时，只有要念的那句文字发给所选服务商；选系统语音时什么都不发。所有语音都是 AI 合成；内置语音包是用 MiniMax 官方系统音色生成的音频，仓库里收录的是这些合成音频和音色署名，没有收录任何真人录音。B 站参考音色（UP 主 星落落_oi 的“ssr大肥鱼音色”）没有被复刻或收录，想复刻需先取得作者许可。录屏公开或商用前请标注 AI 生成并取得相应授权。详见 [README](../README.md#隐私与音色授权) 和 [tts-voice-research.md](tts-voice-research.md)。

### 跳舞（VRM 外观）

- **入口**：她穿 VRM 外观时，桌宠工具栏多一个 ♪「跳舞」按钮；点开是舞蹈列表（封面、名字、时长，没有音乐的标「无音乐」），点一支她就开跳。跳舞中按钮是按下状态，再点开能看到进度、「循环播放」和「停止」；Esc 也能让她停下。像素 / 图片 / Live2D 外观没有这个按钮。
- **设置窗口 → 玩法 → 和她一起 → 舞蹈**：所有舞蹈的卡片（让她跳 / 停止、删除）、正在跳的进度与循环、音乐音量。不是 VRM 外观时页面顶部说明原因，「让她跳」不可点，「去换外观」直达她的装扮页。
- **导入自己的舞蹈**：「导入舞蹈」多选文件（MMD 动作 `.vmd`，可同时选上音乐 mp3 / wav / ogg / m4a / flac、封面 jpg / png / webp、readme），或「选文件夹导入」整个舞蹈文件夹（vidol 舞蹈包按 `meta.json` 识别；MMD 文件夹自动跳过镜头和道具动作）。确认页可以改名字、换动作 / 音乐 / 封面，导入时把动作转换成 VRM 动作并保存到 `<数据目录>/vrm-dances/`；只保存在这台电脑上，不会随角色包导出。失败时写明原因（例如「只有镜头或道具的动作」「音乐是加密格式 .ncm」）。
- **删除**：卡片上的垃圾桶 →「删除舞蹈」；正在跳这支会先停下。内置示例「节拍摇摆」不能删。
- **商店 → 舞蹈**：设置窗口 → 商店 →「舞蹈」分类列出可以下载的舞（封面、动作作者、时长、大小、有音乐），点「下载」就装进舞蹈库；已下载的卡片上直接「让她跳」（只有 VRM 角色能跳，像素角色时先下载好也行）。删除和自己导入的舞一样，在 玩法 → 舞蹈 删。
- **商店 → 角色 → VRM**：VRM 模型也在商店里，按类型筛「VRM」；每张卡有作者和授权摘要，「授权」打开模型文件里写的完整授权（谁可以扮演、商用、再分发、修改、性 / 暴力表现、授权条款链接）。下载后她就是一位 VRM 角色，可以跳舞。18+ 模型只在确认年满 18 岁并开启成人向内容后列出。
- **VRM 角色是独立的伙伴**：商店下载的和自己导入的 VRM 默认用「通用」设定，不挂在大肥鱼等角色名下。每个模型有自己的名字、好感、聊天记录，人设是中性的成年伙伴，名字就是模型名。导入 VRM 时可以在确认页把「设定」改成某位角色的新形象，和她共用好感与聊天。

### 重置姿势（VRM 外观）

不管她在做什么——跳舞、吃饭、玩耍、睡觉、一个反应或姿势卡住、被拖起后没放下——一步就能让她回到待机（Idle）：

| 入口 | 怎么用 |
| --- | --- |
| 桌宠工具栏 **↺「重置姿势」** | 悬停宠物，点 ♪ 右边的 ↺。只在 VRM 外观时出现（像素 / 图片 / Live2D 外观没有姿势会卡住） |
| 快捷键 **Ctrl+Shift+R**（macOS 为 **⌘⇧R**） | 桌宠窗口获得焦点时按；不是全局快捷键，不会抢其他应用的按键 |
| 托盘图标 → **重置姿势** | 宠物被盖住、窗口没有焦点时用 |
| 本地 API `POST /pixel-pet/reset-pose` | 需开启对外接口；返回 `{ ok, before, cleared, woke }`：重置前在做什么、结束了哪些、是否叫醒了她 |

重置会做这些事：停止正在跳的舞（舞蹈层照常 0.5 s 淡出，音乐停止）；结束吃饭、玩耍 / 庆祝这类一次性反应、拖起的举起姿势、走路，以及一句台词的口型；清掉触摸连击留下的生气表情、跳舞中被点出的表情和“无聊坐下”的计时；她在睡觉就叫醒她（**不扣好感、不会因被吵醒而心情变差**，并在 15 分钟内不会自己又睡着）。之后所有动作层按各自的淡出时间平滑回到待机（状态依次是 原动作 → returning → idle），不会瞬间跳变。

- **已经在待机时**：什么都不变（不会换一个待机动作、不会打断她东张西望）。
- **不会打断的**：正在思考或朗读的回复（那是正常状态，要停请用聊天框旁的停止按钮 / Esc）；你在设置里固定的姿势（例如一直坐着）——重置后她回到的就是这个姿势下的待机。
- 重置后可以马上再跳舞、喂食等，不会卡住。

验证：`npm test`（`test/vrm-reset-idle.test.js`：跳舞 / 卡住的舞蹈 / 吃饭 / 睡觉 / 玩耍 / 生气 / 拖起各状态重置都回到干净的 idle，已在 idle 时逐帧无变化）；e2e `xvfb-run -a node e2e/run.js vrmreset`（真实窗口里分别用 ↺、快捷键、托盘、API 从跳舞 / 吃饭 / 睡觉 / 反应 / 拖起重置，截图在 `out/e2e/vrm/reset-*.png`，录屏 `out/e2e/vrm/vrmreset.webm`）。

## 六、设置窗口（配置后台）

所有对整个应用生效的设置都在单独的**设置窗口**里。它不是一页页平铺的后台：左侧只有四个入口——**小屋 / 角色 / 玩法 / 设置**，其余页面都在它们下一层；当前角色的颜色会染在窗口里，亮色 / 暗色跟随系统，也可以用左下角的按钮或「外观主题」固定。打开方式：

- 悬停宠物 → 工具栏 ⏻ 退出左边的 **⚙ 设置**（或在宠物上右键 / 长按）；有新解锁的服饰 / 话题或新版本时 ⚙ 上有小红点，点它直达对应页面
- 桌宠窗口获得焦点时按 **Ctrl+,**（macOS 为 **⌘,**）；macOS 应用菜单 → **偏好设置…**
- 托盘图标 → **打开设置…**（托盘菜单里还有「显示桌宠」「重置姿势」「检查更新」「退出」，宠物被盖住或拖出屏幕时用）

设置窗口只有一个：再次打开时会把已有的窗口提到前面。关掉它不会退出桌宠。从干净克隆开始安装、启动、打开设置窗口和查看角色列表的完整命令见[第十节](#十配置后台从干净克隆跑起来)；VRM / Live2D 的半身模式见[第十一节](#十一半身模式vrm--live2d)。

| 入口 | 下一层 | 内容 | 默认 |
| --- | --- | --- | --- |
| 小屋 | — | 当前角色站在舞台上：**点她一下**会冒出爱心、说一句话，桌面上的她也会做「开心」的动作；下面能切换她的动作（待机、开心、摸头、说话、思考、睡觉……）。旁边是你们的关系（好感进度条，每个关系阶段是一个节点）、今天的陪伴开关（朗读、语音输入、主动搭话、同屏伙伴、对外接口）和其他伙伴 | — |
| 角色 | 角色图鉴 → 角色详情 | 图鉴：每位角色一张卡片（会动的立绘、类型、关系、来源、语音包），没遇见的是剪影；切换 / 初次见面。点开一位进入**详情**：大舞台（可点、可切动作）、简介、口头禅、喜欢的东西、好感进度；下面的标签页：**装扮**（她的**衣柜**是一组服饰卡片：缩略图、名称、全年龄 / 成人、解锁阶段、「新」，点图片在上面的舞台**试穿**，满意再「穿上」；下面是取景、VRM 姿势、她来自的角色包信息，以及「导入新角色」：Live2D / VRM / 角色包）、**好感**（关系路线图、一键解锁）、**模型**、**个性化设定**、**语音**、**资料** | — |
| 玩法 | 桌宠行为 | 宠物大小（50%–250%）、自己走动（E15）、点击音效（E21）、梗图（E22）、互相碰撞（E25）、部位触摸、触摸提示 | 125%、开、关、开、开、开、开 |
| 玩法 | 主动搭话与好感 | 主动说话开关、主动说话间隔、多久没理她算无聊、饥饿提醒阈值、每小时最多调用模型；每日好感上限、久未见面时好感衰减 | 开、12 分钟、45 分钟、75、6 次；12 点、开 |
| 玩法 | 同屏伙伴 | 最多 3 位来串门（E24） | 无 |
| 玩法 · 和她一起 | 话题 | 按好感阶段解锁的话题，「聊聊」让她在桌面上开口；新解锁的标「新」 | — |
| 玩法 · 和她一起 | 聊天记录 | 你主动发起的聊天：列表 → 对话 | — |
| 玩法 · 和她一起 | 桌面上的她 | 动作（9 个）、回到右下角、退出（确认） | — |
| 设置 · 声音 | 朗读 | 朗读回复 / 互动语音 / 朗读碎碎念（E23）、引擎、用不了时、使用语音包；Fish Audio / MiniMax / ElevenLabs / 本地语音服务各一张卡片（端点、Key、ElevenLabs 默认音色 ID / 模型、本地接口 / 模型 / 音色名）；缓存与统计、清空缓存 | 关，按角色，改用系统语音 |
| 设置 · 声音 | 语音输入 | 开关、引擎、语言、识别后直接发送、快捷键（唤起语音对话）、用不了时换另一个引擎、单次最长录音、LobeHub 模型、本地服务的地址 / 接口 / 模型 / 超时 / Key、测试连接；详见 [asr.md](asr.md) | 关；LobeHub、`gpt-4o-mini-transcribe`，本地 `http://127.0.0.1:8179` |
| 设置 · 声音 | 语音包 | 我的语音包（所有角色统一用哪个）；每个语音包的角色、引擎、句数、来源（内置 / 自定义 / 商店下载）和署名；打开文件夹、重新读取 | 自动 |
| 设置 · 资源与外观 | 角色包 | 所有角色包；导入角色包，导出 / 删除导入的包，打开角色包文件夹（导入的每个包都是一位独立角色，在角色图鉴里切换） | — |
| 设置 · 资源与外观 | 外观主题 | 设置窗口的亮色 / 暗色 / 跟随系统 | 跟随系统 |
| 设置 · 连接 | LobeHub 与本机 | 登录账号、空间（只读）、本机能力（开启前确认）、重新开始话题 | — |
| 设置 · 连接 | 对外接口 | 开关、端口、令牌（遮罩显示，可复制、换一个）（E26） | 关，端口 7340 |
| 设置 · 系统 | 内容与安全 | 18+ 确认状态、成人向内容（打开要先确认已满 18 周岁） | 关 |
| 设置 · 系统 | 版本与更新 | 当前版本、状态、检查更新、立即更新 | 启动后检查一次，之后每 4 小时 |
| 设置 · 系统 | 数据与关于 | 硬件加速（**重启后生效**）、打开日志 / 角色包 / 语音包文件夹、素材署名、仅重置本地 / 放生并删除 agent | 开 |

「玩法」和「设置」打开是一页入口卡片，每张卡片写着这一项现在的状态（例如「大小 125% · 走动 开」）；「玩法」顶上还有她此刻的心情、饱腹和精力。进入下一层后，页面左上角是返回上一层的路径。

几条约定：

- 开关、下拉和滑块改了立刻保存并生效，右下角提示「已保存」；端点、Key、数字这类要输入的项填好后点「保存」，填得不对会在下面写明原因，不会保存。
- 每一项都标了默认值，和默认不同时旁边有「恢复默认」；页面右上角「恢复本页默认」一次恢复整页。
- API Key 只能写入：保存后只显示「已设置」，不会再显示出来；对外接口的令牌默认遮罩。
- 需要重启才生效的项（目前只有「硬件加速」）会标「重启后生效」，改了以后每页顶部都提示，并有「立即重启」按钮。
- 设置保存在 `settings.json`（Key 在 `tts-keys.json`），重启和换角色后都保留。在桌宠窗口里改的（拖大小手柄、在角色列表里切换角色）会立刻同步到设置窗口，反过来也一样。

**角色列表的数据从哪来、怎么扩展**：列表不存自己的数据，每一行都由主进程 `src/core/roster.js`（`buildRoster` / `packRows`）从 `PetService.view()` 派生——角色文件 `src/characters/<id>.json`（名称、称号、厂商）、`pet.json` 里的关系与进度、角色包 `src/renderer/packs/<id>-*/pack.json` 与导入的包（类型、来源、预览图）、`settings.json` 里按角色的外观 / 模型 / 设定，以及语音包列表；`src/main/main.js` 的 `adminState()` 在每次变化后把它推给设置窗口（IPC `admin-state`）。新增一位角色只要加一份 `src/characters/<id>.json` 和一个角色包（见[第八节](#八新增一个厂商角色)），不用改后台代码，重启后她就出现在列表里；导入的角色包在「外观资源」页导入后立即出现。

桌宠窗口里只剩互动（喂食、玩耍、睡觉、聊天）和 ⚙ 设置按钮（T-2718）。原来 ⋯ 菜单、话题和衣柜的每一项都在设置窗口里：

| 原来在桌宠里 | 现在在设置窗口 |
| --- | --- |
| 新版本（下载 / 立即更新） | ⚙ 上的小红点 → 设置 › 版本与更新 › 下载新版本 / 立即更新 |
| 设置… | ⚙ 设置按钮（也可右键 / 长按她、Ctrl/⌘ + ,） |
| 角色列表 | 角色 › 角色图鉴 › 她的页 |
| 衣柜 | 角色 › 她的页 › 装扮 › 衣柜（关系升级提示「去衣柜看看」直达） |
| 话题 | 玩法 › 和她一起 › 话题（点「聊聊」她在桌面上开口；提示「去聊聊新话题」直达） |
| 聊天记录 | 玩法 › 和她一起 › 聊天记录 |
| 重新开始话题 | 设置 › LobeHub 与本机 › 重新开始话题（再确认一次） |
| 成人向内容：开 / 关 | 设置 › 内容与安全 › 成人向内容（打开要先确认已满 18 周岁） |
| 本机能力：开 / 关 | 设置 › LobeHub 与本机 › 本机能力（开启前再确认一次） |
| 动作… | 玩法 › 和她一起 › 桌面上的她 › 动作 |
| 回到右下角 | 玩法 › 和她一起 › 桌面上的她 › 回到右下角 |
| 检查更新 | 设置 › 版本与更新 › 检查更新 |
| 放生并删除 agent / 仅重置本地 | 设置 › 数据与关于 › 危险操作（再确认一次） |
| 打开错误日志 / 素材署名 | 设置 › 数据与关于 |
| 退出 | 玩法 › 和她一起 › 桌面上的她 › 退出（再确认一次）；也可以用托盘 → 退出 |

宠物大小也可以直接在桌面上调：悬停时拖左上角的 ⤡ 手柄，或按住 Ctrl/⌘ 在宠物上滚动。

### 设计系统位置与维护

设置窗口和桌宠窗口共用一套 LobeHub 设计系统（lobe-design 初始化，`@lobehub/ui` 主题），详细说明见 [design-system.md](design-system.md)：

| 位置 | 内容 |
| --- | --- |
| `.agents/skills/lobe-design/` | lobe-design 技能（从 [lobe-design-skill](https://github.com/lobehub/lobe-design-skill) 安装）；项目层在 `.agents/ux/`（`product.md`、`components.md`、`lobe-design-rules.md`），`AGENTS.md` 末尾是它的托管块 |
| `admin/` | 设置窗口源码（Vite + React 19 + `@lobehub/ui`）；`admin/src/design/` 是令牌（`tokens.ts`）、明暗（`theme.ts`）和根组件 `DesignProvider`；构建产物在 `src/admin-ui/`（不入库） |
| `src/renderer/design/` | 桌宠窗口用的令牌导出 `lobe-tokens.css` / `tokens.json`（入库），由 `@lobehub/ui/theme.css` 生成；`src/renderer/style.css` 只引用这些 `--lobe-*` / `--pet-*` 变量 |

维护：

- 改后台：`npm run dev:admin`（Vite 开发服务器）或 `npm start`（`prestart` 会先 `npm run build:admin`）；提交前跑 `npm run typecheck:admin` 和 `npm run lint:design`（0 FAIL）。
- 升级 `@lobehub/ui` 后跑 `npm run design:tokens` 重新导出 `src/renderer/design/*` 并提交；`npm test`（`test/design-system.test.js`）会检查导出与主题同步、lobe-design 项目层未过期。
- 新组件优先用 `@lobehub/ui` 现有组件，不在项目里重写原子组件（规则见 `.agents/ux/components.md`）；颜色、字号、间距、圆角按角色取 token，不写死色值。
- 看效果：`npm run design:preview`（令牌和组件预览，亮 / 暗），`xvfb-run -a node e2e/run.js design` / `petui` / `admin` 分别检查预览页、桌宠窗口和设置窗口。
- 刷新 lobe-design 技能：在技能仓库里重新执行 `./install.sh --dir <本仓库>/.agents/skills --copy`，再跑 `node .agents/skills/lobe-design/scripts/bootstrap.mjs --check --root .` 和 `project-scan.mjs --check --root .`。

## 七、打包与发布

```bash
npm run dist:linux     # dist/PixelPetAffection-<版本>-linux-x64.tar.gz
npm run dist:mac       # 只能在 macOS 上：universal dmg + zip
npm run dist:win       # Windows x64 安装包 + zip
```

### 分支与自动发版（同 LobeHub OSS）

- **canary**（默认分支）：日常 PR 都合到这里，每个 PR 和每次合并跑 `npm test`（`.github/workflows/test.yml`），不打包。
- **main**：只放要发布的代码。PR 合进 main 就由 `.github/workflows/release.yml` 自动发版：
  - 标题 `🚀 release: vX.Y.Z` 的 PR（通常是 canary → main）发布 vX.Y.Z；PR 描述就是这一版的发布说明。
  - 标题以 feat / fix / style / refactor / perf / hotfix / build 开头（前面可带 gitmoji），或来自 `hotfix/*`、`release/*` 分支的 PR：在最新正式 tag 上 patch + 1 发版。
  - 其他（docs、chore、test、ci…）不发版。规则与测试见 `scripts/release-version.js`。
- 发版时依次：`npm test` → 在 macOS / Windows / Linux runner 上用该版本号打包（mac / win 跑自更新文件检查，Linux 启动打好的包 15 秒确认不崩）→ 打 tag、创建 GitHub Release（附 `.github/release-notes.md` 的安装说明）→ 把版本号提交回 main 的 `package.json` → main 同步回 canary（`.github/workflows/sync-main-to-canary.yml`；冲突时自动开一个 `sync/main-to-canary-*` PR）。
- 也可以手动：推 `vX.Y.Z` tag 发布该 tag；在 Actions 页运行 Release 并填版本号，发布所选分支；不填版本号只构建，文件留作 run artifact。

发布后可在 Actions 页手动运行 `.github/workflows/update-e2e.yml`：装一个自称旧版本的构建，检查它能下载最新 Release 并替换自己。

## 八、新增一个厂商角色

一个角色 = 一份数据文件 + 一个角色包，**不需要改应用代码**。杰米（`src/characters/gemini.json` + `src/renderer/packs/gemini-pixel/`）和吉皮缇（`src/characters/gpt.json` + `src/renderer/packs/gpt-pixel/`）都是按下面的步骤加进来的，可以直接对照。下面以再新增一位 “Kimi 娘”（id `kimi`）为例。

1. **准备美术（角色包）**：新建 `src/renderer/packs/kimi-pixel/`，内含 `pack.json` 和 `sheets/daily.png`。
   - 最快的做法是复制一个现有像素包，改 `pack.json` 的 `id`（`kimi-pixel`）、`name`、`author`、`license`、`description`，并把 `species` 改成 `kimi`。
   - 自己画：按 [pet-packs.md](pet-packs.md) 的 schema 2，精灵图 1328×3616（4 列 × 8 行，每帧 332×452；内置包是 4 列 × 9 行、每帧 664×904 的 WebP、`pixelated: false`，按平滑方式绘制），动作名就是状态名，只有 `idle` 必填，缺的状态按回落链降级。本仓库用 GPT Image 2.5 生成：`python3 scripts/art/model_chan_prompts.py --halves` 出提示词 → `lh gen image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"` → `scripts/art/slice_sheet.py` → `scripts/art/fit_cells.py`（紫粉色系角色改用绿底生成，两个脚本都加 `--key green`；白色系角色在 `slice_sheet.py` 加 `--octree`，否则西瓜、饼干和肤色会被并进品红色调后删掉）→ `scripts/art/build_model_chan_pack.py` → `scripts/art/check_model_chan.py` 校验（参数见 [art/model-chan/README.md](../art/model-chan/README.md)）。
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
     "personality": "你是 Kimi 娘“琪米”（成年角色，设定年龄 18 岁）……",
     "catchphrase": "……", "likes": "……",
     "fallback": { "hungry": ["…"], "bored": ["…"], "happy": ["…"], "sleepy": ["…"], "greet": ["…"], "fed": ["…"], "patted": ["…"], "played": ["…"] }, // fed / patted / played 可省略：喂食 / 摸摸 / 玩耍时她自己的台词
     "adult": false,
     "outfits": ["daily"],           // 只列有美术的服饰，必须含 daily；内置五位列出全部 13 套全年龄服饰，加服饰的方法见 art/model-chan/README.md「其他服饰」
     "signature": { "label": "…", "desc": "…" },
     "art": { "kind": "pack", "packs": ["kimi-pixel"], "fallbackPack": "kimi-pixel" },
     "fx": { "noMirror": [] },       // 画了文字、镜像会反字的状态列在这里
     "models": { "match": "^kimi-", "providers": ["moonshot"], "prefer": ["kimi-k3"] }, // 她能用的模型：id 匹配 match，来自 LobeHub 托管或这些服务商；prefer 是默认模型的候选
     "voice": {                      // 语音（可省略）
       "lang": "zh-CN", "pitch": 1.1, "rate": 1.0, "prefer": ["Xiaoxiao"], // 系统语音：语言、音调、语速、优先的系统语音名
       "tts": {                      // 云端引擎的音色，每个引擎可省略
         "default": "fish",           // “按角色”时用的引擎：fish / minimax / elevenlabs / local（省略为 fish；大肥鱼是 minimax）
         "fish": { "referenceId": "<32 位 Fish 音色 id>", "model": "s2.1-pro", "speed": 1.0, "volume": 0, "moodTags": { "happy": "开心地" }, "credit": "Fish Audio 社区音色「…」by …" },
         "minimax": { "voiceId": "Chinese (Mandarin)_Soft_Girl", "model": "speech-2.8-turbo", "speed": 1.0, "pitch": 0, "vol": 1, "emotion": "happy" },
         "elevenlabs": { "voiceId": "<ElevenLabs voice_id，20 位字母和数字>", "model": "eleven_multilingual_v2", "stability": 0.5, "similarityBoost": 0.75, "style": 0, "speed": 1.0, "speakerBoost": true }, // 可省略：只有 voiceId 必填；不写时用 设置 → 朗读 → ElevenLabs 的默认音色 ID
         "local": { "voice": "whale" }  // 可省略：她在本地语音服务上的音色名（不写就用设置里填的）
       },
       "lines": { "lift": ["…", "…"], "throw": ["…", "…"], "catch": ["…", "…"] } // 拖拽 / 甩出 / 接住时说的台词（互动语音）
     },
     "memes": [{ "id": "hello", "label": "你好呀", "desc": "挥手打招呼时" }],          // 梗图：图片放 src/renderer/assets/memes/kimi/<id>.webp
     "credits": ["设定：…（许可）", "像素图：…（许可）"]
   }
   ```

   字段由 `src/core/species.js` 的 `validateCharacter` 校验，缺字段或格式不对时应用启动会报出具体原因；旧角色 id（`embit`、`bubbo`、`sprig`）不能再用。视频角色用 `"art": { "kind": "video", "dir": "assets/<id>", "clips": { "idle": "idle.webm", … }, "packs": [] }`，参考 `src/characters/dafeiyu.json`；一个状态可以给一组片段（`"pat": ["a.webm", "b.webm"]`），每次轮换播放。`memes`、`voice` 和 `models` 可省略（没有梗图 / 用默认音色 / 不限定模型，agent 用账号默认模型）；梗图文件缺失时启动会报错。
3. **写清授权**：在 `credits`、`pack.json` 的 `license` / `author` 和 [NOTICE.md](../NOTICE.md) 写明素材来源与许可；所有角色都必须是成年人，不得有裸露或露骨内容（[pet-packs.md](pet-packs.md#内容要求)）。`personality` 必须写明“成年角色，设定年龄 18 岁”；角色文件里不能出现“少女、少年、萝莉、宝宝、校服、孵化”等幼态或成长用词（`test/compliance.test.js` 会逐行检查，写“姑娘”而不是“少女”）。
4. **运行确认**：`npm start`，选择模型娘界面会多出一张 Kimi 卡片，唤醒后所有效果自动可用。角色卡会按窗口宽度自动收窄。
5. **更新测试**：下面几处固定了现有角色，把新角色加进去，再跑 `npm test` 和 `xvfb-run -a node e2e/run.js roster kimi`：
   - `test/characters.test.js`：角色 id 列表和厂商列表；
   - `test/dafeiyu.test.js`：角色 id 列表；
   - `test/packs.test.js`：内置角色包 id 列表（加 `kimi-pixel`）和逐角色检查的 id 列表；
   - `e2e/run.js` 的 `ROSTER`：加一行 `{ id: 'kimi', idx: 5, zh: '琪米', vendor: 'Moonshot' }`（`idx` 是角色卡的位置，从 0 开始），`SPECIES_MEMES` 加她的一张梗图 id；
   - `test/dsh-effects.test.js`：逐角色梗图检查的 id 列表；
   - `test/outfits.test.js`：逐角色衣柜检查的 id 列表和招牌服饰名（内置五位的衣柜都是 13 套全年龄服饰；新角色没有某套服饰的图时不要在 `outfits` 里列它）；
   - `e2e/run.js` 里角色卡数量（`.char-card` 的 `count()`，三处）、厂商列表（`vendors`）、`art` 总表的像素包列表，以及导入非法角色包时报错信息里的角色 id 列表；
   - `docs/pet-packs.md` 的 `species` 注释；
   - `art/model-chan/characters.json`（设计记录，预览拼图从这里读角色）、`art/model-chan/CHARACTERS.md`、`art/model-chan/README.md`、`README.md`、`NOTICE.md` 和 `docs/compliance-review.md` 的角色表。
6. **更新文档**：在 [角色清单](characters.md) 的总表和第二节各加一份（桌面截图取 `out/e2e/` 里她的 `e2-on-the-desktop-she-idles` 截图，放到 `docs/img/characters/<id>-desktop.png`）。

## 九、测试

| 命令 | 内容 |
| --- | --- |
| `npm test` | 单元测试（`node --test test/*.test.js`，假 `lh`，不联网），包括角色文件、角色包、效果、合规词表的校验 |
| `xvfb-run -a node e2e/run.js roster` | 逐个角色选择、唤醒，逐项触发 E1–E14 和 N1–N14（即 E15–E26 及其开关）；截图在 `out/e2e/`，录屏在 `out/e2e/roster-video/<角色>/`。`... roster claude` 只跑一个角色 |
| `xvfb-run -a node e2e/run.js outfit [角色] [服饰]` | 第二套服饰的真机检查（默认 `claude swimsuit`）：真实升级解锁 → 衣柜换上 → idle / walk / lifted 与 daily 对齐 → 重启保留 → 选「旧版像素」时回落到默认包 → 无控制台报错；截图和 `report.txt` 在 `out/e2e/outfit-<角色>-<服饰>/` |
| `xvfb-run -a node e2e/run.js art` | 输出服饰总表 `out/e2e/outfit-sheet.png` 和“每个角色 × 每个状态”总表 `out/e2e/state-sheet.png` |
| `xvfb-run -a node e2e/run.js <场景>` | 其他场景：`fresh`（首次启动）、`wardrobe`（好感升级 → 解锁 → 换装 → 重启 → 关闭成人向，输出在 `out/e2e/affection-ui/`）、`migrate`（旧存档迁移）、`charmigrate`（形象包时代的旧数据 → 独立角色：迁移、二次启动幂等、角色图鉴 / 衣柜卡片 / 切换不串数据，输出在 `out/e2e/charmigrate/`）、`wardrobepack`（角色图鉴每个形象一张卡、衣柜卡片、穿上、各角色衣柜隔离）、`dafeiyu`、`busy`、`space`（放在哪里）、`advanced`、`packs`、`update`；`live` 用你真实的 `lh` 登录（会创建并删除一个真实 agent，消耗少量 token）；`all` 依次跑以上全部场景**再加** `art`、`roster` 和 `live`，所以要先 `lh login`，否则 live 那一段失败。在本仓库 fresh clone 上 `all` 共 282 步，约 15 分钟 |
| `xvfb-run -a node e2e/run.js admin` | 设置窗口：三种打开方式、每个分组、开关 / 下拉 / 滑块 / 输入项的编辑和保存（重启后保留）、恢复默认、角色列表与角色详情、行为控制同步到桌宠、亮 / 暗主题；截图在 `out/e2e/admin/` |
| `xvfb-run -a node e2e/run.js titlebar` | 设置窗口在 macOS 上可拖动：页面按 darwin 渲染（`PIXELPET_E2E_PLATFORM`，仅测试模式），顶部 32px 拖动条（`-webkit-app-region: drag`）横跨整窗、各页没有可点控件压在它下面、角色页滚动后舞台停在它下方；真实平台（原生标题栏）下没有拖动条；截图在 `out/e2e/titlebar/` |
| `xvfb-run -a node e2e/run.js admincov` | 配置覆盖度：每个配置项在设置窗口里都有控件，角色图鉴各类角色、详情各标签页，改动出现在桌宠窗口 |
| `xvfb-run -a node e2e/run.js vrmframe` / `live2dframe` / `spriteframe` | 半身模式：VRM（现做测试 VRM）/ Live2D（大肥鱼 · Live2D + 导入的模型）/ 像素（克洛蒂 · 像素 + 旧版像素）的全身 ↔ 半身、交互、重启保留；见[第十一节](#十一半身模式vrm--live2d)和 [half-body-mode.md](half-body-mode.md#如何复现) |
| `xvfb-run -a node e2e/run.js petui` / `design` | 桌宠窗口的 LobeHub 风格（菜单、面板、气泡、输入框，亮 / 暗）/ 设计系统预览页 |
| `xvfb-run -a node e2e/run.js voicehotkey` | 快捷键唤起语音对话：快捷键 → 唤出桌宠、录音、识别（mock whisper）、直接发送；语音输入关闭 / 麦克风被拒提示；设置页的无效 / 冲突 / 被占用提示，改组合、清空、恢复默认、退出注销 |
| `xvfb-run -a node e2e/run.js asr` | 语音输入：假麦克风 → MediaRecorder → mock whisper 服务 → 输入框（不耗 token）；加 `PIXELPET_E2E_WHISPER` / `PIXELPET_E2E_ASR_LOBEHUB` 时额外走真实 whisper 服务和 LobeHub 云端识别，见 [asr.md](asr.md#7-验证开发者) |
| `node e2e/content-sets.js` | 输出全部内容条目及成人向开 / 关两种状态下的内容集合 |
| `PIXELPET_CLEAR_JWT=1 node e2e/adversarial-live.js` | 用真实 LobeHub agent 跑 4 条对抗性请求（创建并删除一个临时 agent，消耗少量 token） |

e2e 通过 Playwright 启动真实 Electron 应用（自动带 `--no-sandbox`，用假 `lh`）。

## 十、配置后台：从干净克隆跑起来

这一节按顺序给出从一台干净的机器到打开**配置后台（设置窗口）**、查看角色列表的全部命令。设置窗口各页的内容见[第六节](#六设置窗口配置后台)，设计与覆盖矩阵见 [admin-console-design.md](admin-console-design.md)。

**前置条件**：Node.js 20+（含 npm）、git；Linux 需要桌面会话，没有显示器时装 `xvfb`（Debian / Ubuntu：`sudo apt-get install -y xvfb`）。试玩不需要 LobeHub 账号（下面用测试里的假 `lh`）；要和真实的 agent 聊天再装 `npm install -g @lobehub/cli`。

```bash
# 1. 克隆（默认分支 canary）
git clone https://github.com/rdmclin2/lobehub-pixel-pet-affection.git
cd lobehub-pixel-pet-affection

# 2. 按 package-lock.json 安装依赖（包括 Electron、Vite、@lobehub/ui）
npm ci
#    Electron 的二进制在第一次启动时下载（终端显示 Downloading Electron binary...）。
#    如果启动报 "Electron failed to install correctly"，手动补一次：node node_modules/electron/install.js

# 3. 启动桌宠。prestart 会先执行 npm run build:admin，把设置窗口构建到 src/admin-ui/
npm start                              # macOS / Windows / 配好 chrome-sandbox 的 Linux
npm run start:no-sandbox               # Linux 从源码运行（chrome-sandbox 没有 setuid 时）
xvfb-run -a npm run start:no-sandbox   # 没有显示器的 Linux
```

**不登录 LobeHub 试玩**：在启动命令前加假 `lh` 的环境变量，单独的数据目录不会碰到正式存档：

```bash
mkdir -p /tmp/fake-lh && touch /tmp/fake-lh/loggedin
LH_BIN="$PWD/test/fixtures/fake-lh.js" FAKE_LH_DIR=/tmp/fake-lh PIXELPET_DATA_DIR=/tmp/pp-demo npm run start:no-sandbox
```

第一次启动依次是 18+ 确认 → 选模型娘 → 唤醒（第三节）；之后宠物出现在屏幕右下角。也可以用 `npm run demo`（第二节）直接启动到一只已唤醒的桌宠，它同样会先执行 `npm run build:admin`（`predemo`）。

**打开设置窗口**（三种方式任选，窗口只有一个，再次打开会提到前面）：

1. 鼠标悬停宠物 → 点 **⋯**（或在宠物上右键）→ **设置…**
2. 桌宠窗口获得焦点时按 **Ctrl+,**（macOS **⌘,**）
3. 托盘图标 → **打开设置…**

左侧四个入口：**小屋**（当前角色、关系、今天的陪伴开关）、**角色**（角色图鉴 → 角色详情）、**玩法**（桌宠行为、主动搭话与好感、同屏伙伴）、**设置**（声音、资源与外观、连接、系统）。开关、下拉和滑块改了立即保存并在桌宠上生效（例如 玩法 → 桌宠行为 → 宠物大小，桌宠窗口跟着变大），右下角提示「已保存」；设置写进数据目录的 `settings.json`，重启后保留。

**查看角色列表**：设置窗口左侧 → **角色**，就是**角色图鉴**：每个形象一张角色卡片（立绘、形象类型、关系、来源、服饰数、语音包），没遇见的显示剪影；上方的筛选按形象类型（像素 / 全动态 / Live2D / VRM / 视频 / 导入的）过滤。点一张卡片进入**角色详情**：大舞台、简介、好感进度，下面的标签页是**装扮**（衣柜卡片、**取景**、VRM 姿势、角色包信息、导入新角色）、**好感**、**模型**、**个性化设定**、**语音**、**资料**。

**开发设置窗口本身**：`npm run dev:admin` 启动 Vite 开发服务器（默认 <http://localhost:5173/>），用于在浏览器里改样式、热更新；浏览器里没有桌宠的 IPC 桥（`window.petAdmin`），所以页面只显示「设置窗口没有加载成功 · 设置窗口没有连上桌宠（window.petAdmin 不存在）」、不加载数据。要看带数据的真实设置窗口，用上面的 `npm start` / `npm run start:no-sandbox`（每次启动都会重新构建），或改完后 `npm run build:admin` 再重开设置窗口。提交前跑 `npm run typecheck:admin` 和 `npm run lint:design`。

## 十一、半身模式（VRM / Live2D）

**半身**只显示腰部以上：同一个窗口里角色画得更大，腰线落在窗口底边，窗口大小和右下角位置不变。对 **VRM**、**Live2D** 和**像素**角色生效，图片 / 全动态角色保持全身。原理、参考 Airi 的取舍、每个包的腰线配置见 [half-body-mode.md](half-body-mode.md)。

**1. 切换到一位 Live2D 或 VRM 角色**（设置窗口 → **角色**）：

- **Live2D（内置）**：角色图鉴里「大肥鱼 · Live2D」是一张独立的卡，点 **切换**（没见过大肥鱼时先点「初次见面」）。
- **Live2D（自己的模型）**：任意一位角色的详情 → **装扮** → 「导入新角色」→ **导入 Live2D 角色…** → 选 `.model3.json` 或 `.zip`（Cubism 3 / 4 / 5）。导入后成为以她为原型的一位新角色并切换过去；在她的装扮页「Live2D 模型大小」调高度。
- **VRM**：仓库里没有可再分发的 VRM 模型，用你自己的 `.vrm`（VRM 0.x / 1.0），或者生成一个测试用的 CC0 小模型：

  ```bash
  node scripts/make-test-vrm.js /tmp/pixelpet-test-fish.vrm
  ```

  然后在角色详情 → **装扮** → 「导入新角色」→ **导入 VRM 角色…** → 选这个 `.vrm`（右下角提示「VRM 模型已导入」），在导入确认里点「使用这个模型」，角色图鉴里多出一位 VRM 角色「Pixel Pet test fish」并切换过去。没有 GPU 的 Linux（虚拟机、xvfb）要让 Chromium 用软件 WebGL 画 3D：`npm run start:no-sandbox -- --enable-unsafe-swiftshader --ignore-gpu-blocklist`。

**2. 切换半身 / 全身**（改完立即生效，不重新加载模型，相机 / 缩放在 0.35 s 内平滑过去）：

| 范围 | 在哪里改 | 存在哪里 |
| --- | --- | --- |
| 所有角色（全局） | 设置窗口 → **玩法** → **桌宠行为** → 「大小与取景」→ **取景**：全身 / 半身 | `settings.json` → `prefs.framing` |
| 只这一位角色 | 设置窗口 → **角色** → 她的详情 → **装扮** 标签 → **取景**：跟随 / 全身 / 半身 | `settings.json` → `framings.<角色 id>` |
| 角色包自带默认 | `pack.json` 的 `"framing": "half"`，腰线 `"halfBody": { "waist": 0.52 }` | 包里（格式见 [pet-packs.md](pet-packs.md)） |

优先级：角色自己的选择 > 角色包默认 > 全局。半身下视线跟随、口型、点击反应、拖起、走动照常；触摸区映射回全身比例，所以腿和脚点不到。重启后取景保留。

**3. 跑相关测试**（`all` 会额外跑消耗 token 的 `live`，不要用）：

```bash
npm test                                   # 单元测试：含 test/framing.test.js、test/framing-live2d.test.js、test/admin-console.test.js
xvfb-run -a node e2e/run.js admin          # 设置窗口：打开方式、各页、编辑保存、角色图鉴与详情、行为同步、亮 / 暗 → out/e2e/admin/
xvfb-run -a node e2e/run.js titlebar       # 设置窗口 macOS 顶部拖动条（按 darwin 渲染）→ out/e2e/titlebar/
xvfb-run -a node e2e/run.js admincov       # 配置覆盖度：每个配置项在设置窗口里都有控件，改动出现在桌宠窗口
xvfb-run -a node e2e/run.js vrmframe       # VRM 半身 / 全身（现做测试 VRM）→ out/e2e/vrm/frame-*.png
xvfb-run -a node e2e/run.js live2dframe    # Live2D 半身 / 全身（内置大肥鱼 Live2D + 导入的模型）→ out/e2e/live2d-frame/
```

e2e 用 Playwright 启动真实 Electron（自动带 `--no-sandbox` 和软件 WebGL、假 `lh`），每个场景最后打印 `N/N passed`，结果追加在 `out/e2e/results.json`。`vrmframe` 会额外拿本机的真实 VRM 拍一组（`PIXELPET_E2E_REAL_VRM=/a.vrm:/b.vrm`，必须在仓库外），没有就跳过这一步。
