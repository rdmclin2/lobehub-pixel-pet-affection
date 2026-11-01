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
3. **本机能力**（默认勾选）：“让它能使用这台电脑”。勾选后，能读到 `lh login` 的登录（或设置了 `LOBEHUB_CLI_API_KEY`）时，这类对话直接走 LobeHub Responses API，读写文件、列目录、运行命令这几个工具由应用在本机执行，不需要连接设备，开启和每一步工具调用都更快；读不到登录或直连失败时，才退回到确保 `lh connect --daemon` 在运行、把 agent 绑定到这台电脑的老办法。它能碰到你账号权限内的所有文件和命令，不是沙盒；之后可以在 ⋯ 菜单 →“本机能力”随时关闭。
4. 起名（可选），点 **唤醒**。进度依次是：
   - 检查 LobeHub 登录（`lh whoami`）；
   - 未登录时在浏览器里登录 LobeHub：应用打开登录页，并显示要确认的验证码（`lh login` 设备码登录）；
   - **把它放在哪里？** 默认个人空间；也可以选你加入的 workspace（那里的成员可能看得到它），之后所有调用固定在这个空间；
   - 创建她的 LobeHub agent（`lh agent create`，人设写进 agent 的系统设定）；
   - 连接这台电脑（勾选了本机能力时）；
   - 醒来：播放唤醒演出。
5. 之后宠物住在桌面上，鼠标悬停时才显示状态条和按钮（喂食、玩耍、睡觉、聊天、话题、衣柜、⋯）。聊天、话题和主动说话通过 `lh agent run` 调她的 agent，每轮复用同一个 LobeHub 话题，所以长期记忆在 LobeHub 里。

⋯ 菜单里的“放生并删除 agent”会删除宠物和每位角色的 LobeHub agent；“仅重置本地”只清本地存档。

## 四、选角与切换角色

- **首次**：在“选择你的模型娘”界面点角色卡，再点“唤醒”。
- **之后切换**：悬停宠物 → ⋯ → **角色列表**。每位角色都有自己的 LobeHub agent（自己的人设、模型、聊天记录）、名字、好感度和需求值（饥饿 / 心情 / 精力 / 睡眠），列表里每行有她的缩略图（当前角色包、穿着的服饰）、名字（你起的名字 + 中文名 + 厂商）、称号，以及“已认识 · 阶段 · 好感 X”或“未见过”。
  - **角色详情**：点列表里的一行（或“设置 ›”）打开她的页面，没见过的角色也能打开；页面顶部“‹ 角色列表”返回。她自己的设置都在这里：**模型**、**个性化设定（System Role）**、**外观（角色包）**、**好感度 · 一键解锁**，只作用于她，不影响当前陪伴的角色。“切换 / 初次见面”在列表和她的页面里都能点。
  - **初次见面**：点没见过的角色旁边的 **初次见面**，给她起个名字（可选，最多 12 个字，默认用她自己的名字）→ **请她来**。应用在你唤醒时选的空间里为她新建 agent（标题 `名字 (英文名)`），这时气泡和面板显示“她正在赶来…”；她从陌生开始，跟你打招呼。新建失败（网络、登录过期、`lh` 被固定在别的 workspace）时留在原角色，什么都不保存，可以再试。
  - **见过的角色**：点 **切换**，她的 agent、聊天记录、名字、好感度和服饰都还在，用一句离线台词打招呼。不在屏幕上的角色需求值暂停，离开的时间也不算冷落她（不掉好感）。
  - 切换后播放唤醒演出。开着“使用本机”时，新角色的 agent 也会绑定到这台电脑；关掉时解绑所有角色的 agent。
- **换画风**：⋯ → **角色列表** → 她 → **外观（角色包）**（每位角色各自选，存在 `settings.json` 的 `appearance`）。每位角色默认用新的高清像素包（每帧 664×904，平滑绘制），也可以换成「旧版像素」（v0.7.0 及以前那套 83×113、更 Q 的像素图）；大肥鱼还能换成原版动画（dsh-pet 透明视频）。随时可以换回来；也可以“导入角色包…”（文件夹或 `.zip`，格式见 [pet-packs.md](pet-packs.md)），“打开角色包文件夹”查看已导入的包。
- **个性化设定**：⋯ → **角色列表** → 她 → **个性化设定（System Role）**。写几句给她的额外设定（怎么称呼你、说话风格、要记住的事，最多 1000 字），点“保存”；它会加进她 agent 的 system role（“主人给你的个性化设定”一段），只对她生效，关系阶段和内容红线仍然优先。给当前角色保存后立即更新她的 agent；给别的角色写的，等她下次陪你时（或初次见面新建 agent 时）用上。“清空”确认后删掉，她回到默认性格。存在 `settings.json` 的 `systemRoles`。
- **换模型**：⋯ → **角色列表** → 她 → **模型**（模型跟着角色走）。下拉框里只有她自家厂商的模型：大肥鱼 DeepSeek、克洛蒂 Claude、格萝可 Grok、杰米 Gemini、吉皮缇 GPT（含 o 系列）。列表来自你在 LobeHub 里启用的模型：LobeHub 托管的排在前面；如果你还启用了该厂商自己的服务商（填了自己的 Key），那些模型也会列出，标“（自己的 … Key）”。只能出图的模型（如 Nano Banana）不列。没选过时用角色的默认模型（标“默认”）：大肥鱼 DeepSeek V4.1 Flash、克洛蒂 Claude Sonnet 5.5、格萝可 Grok 4.7、杰米 Gemini 3.8 Flash、吉皮缇 GPT-6 Luna；默认模型没启用时用列表第一个。给当前角色选好后立即改 agent 的模型；给别的角色选的，等她下次陪你时（下一句话起）换上；换角色后，下一句话起换成新角色的模型，每位角色各自记住你的选择（存在 `settings.json` 的 `models`）。模型列表 10 分钟内复用，点“刷新”立即重读；`lh` 读不到列表（版本太旧或离线）时她继续用原来的模型。
- **请别的模型娘来串门**：高级设置 → **同屏伙伴**，见下面的 E24。

## 五、各效果的触发方式

效果层（`src/core/fx.js` + `src/renderer/fx.js`）移植自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，**五位角色全部支持**，角色之间只差配置、素材和台词。角色缺某个状态的素材时按回落链降级（例如“吃水果”→“吃饭”→“开心”→“待机”）并叠加表情符号。E15–E26 是与 dsh-pet 逐项对照后补上的（T-1163），对照表见 [dsh-pet-gap.md](dsh-pet-gap.md)。

| # | 效果 | 状态 / 动作 | 怎么触发 | 设置开关 |
| --- | --- | --- | --- | --- |
| E1 | 唤醒演出 | `hatch` | 选好角色点“唤醒”；或在 ⋯ → 角色列表里换角色 | 无，始终可用 |
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
| E12 | 关系升级演出：进化、闪光、爱心 | `evolve` | 好感度跨过阶段（15 / 35 / 60 / 85）；角色列表 → 当前角色 → **一键解锁** 直接加满 | 无，始终可用 |
| E13 | 角色专属衣柜 | — | 悬停 → **衣柜**（每位角色 1 套原设服装 + 12 套按好感阶段解锁的全年龄服饰；外观选 18+ 成年版时是成年版日常服 + 11 套成人向服饰） | 无，始终可用 |
| E14 | 切换角色（每位角色各自的 agent、聊天记录、名字和好感度） | `hatch` | 见第四节 | 无，始终可用 |
| E15 | 自己走动（漫游） | `walk` | 鼠标离开、她不忙、没开面板时偶尔朝面向的方向走 60–240 像素，到屏幕边掉头。大肥鱼播 dsh-pet 的螃蟹走路，像素角色用待机帧颠步 + 👣。开关：桌宠行为 →“自己走动” | 桌宠行为 →“自己走动”（默认开） |
| E16 | 触屏长按 / 右键打开菜单 | — | 触屏上按住她 0.5 秒不动；或鼠标右键她 | 无，始终可用 |
| E17 | 动作点播、回到右下角 | 任意状态 | ⋯ → **动作…**（东张西望、转身、走两步、开心、害羞、玩耍、想事情、难过、闪亮登场）；⋯ → **回到右下角** | 无，始终可用 |
| E18 | 弹弓 | `lifted` → `pat` | 0.3 秒内连按两下，第二下按住往反方向拉（至少 20 像素），松手后朝反方向弹出，力度只看拉多远 | 无，始终可用 |
| E19 | 空中接住得分 | `happy` | 甩出后在她飞行时点中她（速度 ≥ 400 px/s 才计分），弹出“+N”和火花，越快、宠物越小分越高 | 无，始终可用 |
| E20 | 落地挤压随冲击加深 | — | 甩得越猛，落地压得越扁（300 px/s 压到 0.8，1500 px/s 以上压到 0.55） | 无，始终可用 |
| E21 | 点击音效 | — | 桌宠行为 →“点击音效”（默认关）；点她时“啵”一声，100 毫秒内连点只响一次 | 桌宠行为 →“点击音效”（默认关） |
| E22 | 梗图贴纸 | — | 桌宠行为 →“梗图”（默认开）。agent 回复时自己挑一张（每条消息附带她的梗图清单）；饿了 / 无聊 / 问候等离线碎碎念随机配图。大肥鱼 9 张，其他角色各 4 张 | 桌宠行为 →“梗图”（默认开） |
| E23 | 语音（TTS）：对话语音 + 互动语音 | — | 桌宠行为 →“朗读回复”（总开关，默认关）。开启后：**对话语音**——agent 的回复、话题和对外接口发来的话整段按句朗读，正在读的句子在气泡里高亮，主人发新消息立即停；**互动语音**（“互动语音”，默认开）——初次见面、摸摸、部位触摸、喂食、玩耍、哄睡、拖拽、甩出、接住、关系升级、切换角色念出她气泡里的那句，连点不排队、1.5 秒内只说一句；**碎碎念**（“朗读碎碎念”，默认关）。引擎在 高级设置 → 语音 选：按角色（默认：大肥鱼用 MiniMax，其他角色用 Fish Audio）、Fish Audio、MiniMax（云端引擎需 API Key）、系统语音（离线免费）；每位角色有自己的音色。云端用不了（没 Key、断网、4 秒超时、出错）时这句改用系统语音或不出声。详见下方“语音（TTS）” | 桌宠行为 →“朗读回复”（默认关）、“互动语音”（默认开）、“朗读碎碎念”（默认关） |
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

### 语音输入（ASR）

高级设置 → **语音输入** 打开后，聊天框旁的 🎤 把你说的话转成文字填进输入框。两种识别方式（复用 LobeHub 云端识别，或本机跑 whisper.cpp / speaches 等本地服务）的安装、配置、测试连接和故障排查见 [asr.md](asr.md)。

### 语音（TTS）

1. **打开**：悬停 → ⋯ → 高级设置 → 桌宠行为 → 打开 **朗读回复**。关着时什么都不念，也不请求任何语音服务。
2. **选引擎**：高级设置 → 语音 →“引擎”。

   | 引擎 | 需要 | 说明 |
   |---|---|---|
   | 按角色（默认） | 她的引擎的 Key | 大肥鱼用 MiniMax「俏皮萌妹」（`qiaopi_mengmei`），其他角色用 Fish Audio；她的引擎没 Key 或出错时换另一个有 Key 的引擎（大肥鱼 → Fish「蓝色大肥鱼」） |
   | Fish Audio | API Key（[fish.audio](https://fish.audio) → API Keys） | 所有角色都用 Fish：模型 `s2.1-pro`，每位角色一个社区音色；免费账号限个人非商业使用 |
   | MiniMax | MiniMax 接口密钥（API Key，[platform.minimaxi.com](https://platform.minimaxi.com) 国内站 → 账户管理 → 接口密钥；不用填 GroupId） | 所有角色都用 MiniMax：`speech-2.8-turbo` + 平台系统音色。默认端点是国内站 `https://api.minimax.cn`；国际站（minimax.io）的 Key 要把端点改成 `https://api.minimax.io` |
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
12. **隐私与授权**：开云端引擎时，只有要念的那句文字发给所选服务商；选系统语音时什么都不发。所有语音都是 AI 合成；内置语音包是用 MiniMax 官方系统音色生成的音频，仓库里收录的是这些合成音频和音色署名，没有收录任何真人录音。B 站参考音色（UP 主 星落落_oi 的“ssr大肥鱼音色”）没有被复刻或收录，想复刻需先取得作者许可。录屏公开或商用前请标注 AI 生成并取得相应授权。详见 [README](../README.md#隐私与音色授权) 和 [tts-voice-research.md](tts-voice-research.md)。

## 六、高级设置一览

悬停宠物 → ⋯ → **高级设置**：

高级设置只放对所有角色生效的系统设置。按角色区分的设置（模型、个性化设定、外观（角色包）、好感度一键解锁）和切换角色不在这里，在 ⋯ 菜单的 **角色列表** → 角色页面（见第四节）。

| 分组 | 内容 | 默认 |
| --- | --- | --- |
| 版本与更新 | 当前版本、上次检查时间、“检查更新” | 启动后检查一次，之后每 4 小时 |
| 桌宠行为 | 自己走动（E15）、点击音效（E21）、朗读回复 / 互动语音 / 朗读碎碎念（E23）、梗图（E22）、互相碰撞（E25） | 开、关、关 / 开 / 关、开、开 |
| 语音 | 引擎（按角色 / Fish Audio / MiniMax / 本地语音服务 / 系统语音）、各引擎的 API Key 与端点、本地语音服务的接口 / 模型 / 音色名、“用不了时”（改用系统语音 / 不出声）、试听一句、清空语音缓存、状态行（Key 是否已设置、缓存大小、上次出错） | 按角色（大肥鱼 MiniMax，其他 Fish），没有 Key，用不了时改用系统语音 |
| 语音输入 | 开关、引擎（LobeHub 云端识别 / 本地识别服务（whisper）/ 关闭）、语言、识别后直接发送、用不了时换另一个引擎、LobeHub 模型、本地服务的地址 / 接口 / 模型 / Key、测试连接；详见 [asr.md](asr.md) | 关；开启后默认 LobeHub、`gpt-4o-mini-transcribe`，本地地址 `http://127.0.0.1:8179` |
| 同屏伙伴 | 勾选最多 3 位来串门（E24） | 无 |
| 对外接口（本机 HTTP） | 开关、端口、令牌（E26） | 关，端口 7340 |

宠物大小也在高级设置里（滑块），或悬停时拖左上角的 ⤡ 手柄、按住 Ctrl/⌘ 在宠物上滚动，范围 50%–250%，默认 125%（“恢复默认”按钮回到它）。设置保存在 `settings.json`，重启和换角色后都保留。

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
         "default": "fish",           // “按角色”时用的引擎：fish / minimax / local（省略为 fish；大肥鱼是 minimax）
         "fish": { "referenceId": "<32 位 Fish 音色 id>", "model": "s2.1-pro", "speed": 1.0, "volume": 0, "moodTags": { "happy": "开心地" }, "credit": "Fish Audio 社区音色「…」by …" },
         "minimax": { "voiceId": "Chinese (Mandarin)_Soft_Girl", "model": "speech-2.8-turbo", "speed": 1.0, "pitch": 0, "vol": 1, "emotion": "happy" },
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
| `xvfb-run -a node e2e/run.js <场景>` | 其他场景：`fresh`（首次启动）、`wardrobe`（好感升级 → 解锁 → 换装 → 重启 → 关闭成人向，输出在 `out/e2e/affection-ui/`）、`migrate`（旧存档迁移）、`dafeiyu`、`busy`、`space`（放在哪里）、`advanced`、`packs`、`update`；`live` 用你真实的 `lh` 登录（会创建并删除一个真实 agent，消耗少量 token）；`all` 依次跑以上全部场景**再加** `art`、`roster` 和 `live`，所以要先 `lh login`，否则 live 那一段失败。在本仓库 fresh clone 上 `all` 共 282 步，约 15 分钟 |
| `xvfb-run -a node e2e/run.js asr` | 语音输入：假麦克风 → MediaRecorder → mock whisper 服务 → 输入框（不耗 token）；加 `PIXELPET_E2E_WHISPER` / `PIXELPET_E2E_ASR_LOBEHUB` 时额外走真实 whisper 服务和 LobeHub 云端识别，见 [asr.md](asr.md#7-验证开发者) |
| `node e2e/content-sets.js` | 输出全部内容条目及成人向开 / 关两种状态下的内容集合 |
| `PIXELPET_CLEAR_JWT=1 node e2e/adversarial-live.js` | 用真实 LobeHub agent 跑 4 条对抗性请求（创建并删除一个临时 agent，消耗少量 token） |

e2e 通过 Playwright 启动真实 Electron 应用（自动带 `--no-sandbox`，用假 `lh`）。
