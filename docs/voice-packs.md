# 语音包：专属语音包、通用男女语音包与风格语音包

> 用户怎么用（商店下载、按角色选择）：[README「风格语音包」](../README.md#风格语音包商店下载--按角色选择)、[usage.md 语音（TTS）第 12 条](usage.md#语音tts)。生成：§5、§6.3；托管与发布、新增风格：§9。

语音包是一组提前录好的固定台词（`manifest.json` + 音频文件）。命中台词时直接从磁盘播放，不请求引擎（代码：`src/core/voice-pack.js`）。agent 回复这类不固定的话仍然交给引擎朗读。

## 1. 两种语音包

| `kind` | 含义 | 必填字段 | 内置 |
| --- | --- | --- | --- |
| `character`（省略 `kind` 时就是它，旧包都是这种） | 专属语音包：某一个角色自己的台词和声音 | `format` `id` `name` `character` `lines` | `src/voicepacks/{claude,dafeiyu,gemini,gpt,grok}` |
| `generic` | 通用语音包：跟角色无关的通用台词，按性别分男声 / 女声 | `format` `kind` `gender`（`male` / `female`）`id` `name` `engine` `voiceId` `lines`；**不能有** `character` | `src/voicepacks/generic-male`、`src/voicepacks/generic-female` |
| `style` | 风格语音包：一包 = 一种声音风格（可爱 / 御姐 / 少年 / 沉稳 / 搞笑），从商店下载，见 §6 | `generic` 的全部必填字段 + `style` `version` `lineSet` `sample` | 不内置；源文件在 `catalog/voicepacks/style-*`，商店目录 `src/core/voice-catalog.json` |

```json
{
  "format": 1,
  "kind": "generic",
  "gender": "male",
  "id": "generic-male",
  "name": "通用男声（MiniMax 青涩青年）",
  "engine": "minimax",
  "voiceId": "male-qn-qingse",
  "model": "speech-2.8-turbo",
  "params": { "speed": 1, "pitch": 0, "vol": 1, "emotion": "happy" },
  "credit": "语音由 AI 合成：MiniMax 青涩青年（male-qn-qingse）",
  "lines": { "<台词原文>": "<文件>.ogg" },
  "pending": ["<还没录的台词>"]
}
```

- 通用包的 `engine` + `voiceId`（加上 `model`、`params`）同时也是**这个性别的默认 TTS 音色**：如果一个角色回退到这个包，而她的角色文件里没有 `voice.tts`，引擎朗读（比如 agent 回复）也用这个音色（`voiceForPack`）。`engine` 可以是 `fish` / `minimax` / `elevenlabs`，音色按角色文件 `voice.tts.<engine>` 的同一套规则校验（`validateVoice`）。
- `pending` 是可选字段，列出还没录音的台词（生成脚本会写它），加载时不读。
- 同一个 `id`，用户目录（`userData/voicepacks/`）里的包覆盖内置包；同一个性别的通用包也是用户目录的优先。
- `VoicePacks.list()` 每项都带 `kind` 和 `gender`（专属包的 `gender` 是 `null`，`character` 是角色 id；通用包的 `character` 是 `null`）。

## 2. 角色性别（`src/core/voice-gender.js` `genderOf`）

按下面顺序取第一个能用的值：

1. 角色文件 `src/characters/<id>.json` 的 `gender`，没有时看 `voice.gender` → `source: 'character'`（5 个内置角色都写了 `"gender": "female"`）
2. 她本身对应的包，或者她默认穿的包：`pack.json` 的 `gender`，没有时看 `voice.gender` → `'pack'`
3. 同一个包的 VRM 动作风格 `vrm.style`（`"male"` / `"female"`，或者 `{ "base": … }`）→ `'style'`
4. 从模型推断（`vrm-style.js` `inferVoiceGender`，比动作风格用的 `inferFromBody` 更严，见下方「性别推断」）→ `'model'`
5. **默认 `female`** → `'default'`

`neutral` 风格或者推断结果是 neutral 时，都说明不了声音该用男声还是女声，所以继续往下一步走，最后落到默认的 `female`。默认取女声的原因：应用自带的所有角色，以及通用伙伴模板（`core/generic.js`）都用「她」来写，女声和文字对得上的可能性更大。

### 性别推断（模型 → 声音，T-5076）

VRM meta 没有性别字段，只能从骨骼读（`vrm-style.js` `bodyFromJson`）：`bustSpring`（挂在 SpringBone 上、名字含 bust/breast/胸 的骨骼数）、`bustBones`（名字含 bust/breast/胸、但不是 VRoid 模板 `J_Sec_*_Bust*` 的骨骼数，不管有没有挂 SpringBone，碰撞体 `*Collider` 不算）、`vroidBust`（VRoid 模板的 `J_Sec_*_Bust*` 数，男性 VRoid 模型也有）、`shoulderHip`（肩宽 ÷ 髋宽）。

声音用 `inferVoiceGender`，按顺序：

| 条件 | 结果 |
|---|---|
| `bustSpring > 0` 或 `bustBones > 0` | female |
| `shoulderHip ≥ 1.8` | male |
| `vroidBust > 0`（VRoid 骨架，胸部没挂 SpringBone）且 `shoulderHip ≥ 1.5` | male（VRoid Studio 给女性角色的胸部挂 SpringBone） |
| 其他 | neutral → 默认 female |

原来声音直接用动作风格的规则（胸部有 SpringBone → 女，`shoulderHip ≥ 1.5` → 男）。对商店 73 个模型离线扫描时，Elysia（女，`shoulderHip` 1.54，有 `joint_LeftBreast` 等乳房骨骼但没挂 SpringBone）和 Liqu（女，1.52，没有任何乳房骨骼）都被判成了男声。扫描结果里所有男性非 VRoid 模型的 `shoulderHip` 都在 1.90–2.30，没有一个带乳房骨骼；女性模型最高 1.64（胸部挂了 SpringBone）。所以把男声门槛提到 1.8，并且有乳房骨骼时直接判女。

动作风格（`inferFromBody`）只加了一条：有 `bustBones` 时不再判 male（落到 neutral）。73 个模型中只有 Elysia 的动作风格变了（male → neutral）；Liqu 的动作风格仍是 male，因为 1.5 门槛没动。

校验：角色文件的 `gender` / `voice.gender`（`species.js validateCharacter`，`tts.js validateVoice`），以及 `pack.json` 的 `gender` / `voice.gender`（`packs.js validatePack`，这里 `voice` 只能写 `{ "gender" }`）都只接受 `female` / `male`，这几个字段都可以不写。

## 3. 用哪个语音包（`resolvePack`，纯函数）

1. 用户为这个角色选的包：`settings.tts.voicePackByCharacter[角色 id]`，可以选任何一个已加载的包（包括商店下载的风格包）→ `source: 'user'`；选 `none`（**不使用**）→ 不用任何语音包，`source: 'none'`，全部交给引擎、用她自己的音色（它也盖过「我的语音包」）
2. **我的语音包**（用户自己的语音包）：`settings.tts.voicePack`，可以选通用男声 / 通用女声或任何一个已加载的包，所有没有单独指定的角色都用它 → `'default'`
3. 她自己的专属包 → `'own'`
4. 她这个性别对应的通用包 → `'generic'`

如果选的包已经不在了（比如被删了），就按「自动」处理，同时在 `missing`（角色的）/ `userMissing`（我的语音包）里返回那个包的 id。`voicePack` 是 `auto`（默认）时，解析结果和没有这一项时完全一样。新导入、没有专属包的模型会自动用上 `generic-male` 或 `generic-female`。5 个内置角色在「自动」下仍然用各自的专属包，引擎音色也不变（单测 `the five built-in characters resolve exactly as before`）。

引擎音色（`voiceForPack`）的规则：

- 角色文件写了 `voice.tts`：在「自动」下保持不变。
- 用户为她选了别的包，或者她跟随「我的语音包」用了别的包：改用那个包的音色，这样录好的台词和引擎合成的话是同一个声音。
- 没有 `voice.tts` 并且回退到了通用包：用通用包的音色。

## 4. 设置与 IPC

`settings.tts.voicePackByCharacter`：`{ [角色 id]: 包 id }`，默认值是 `{}`；没有这个字段的旧设置文件迁移后也是 `{}`。校验（`tts.js normalizeVoicePackPicks`）规则：

- 角色 id 要匹配 `^[a-z][a-z0-9]{1,19}$`（包括 `vrmx…` 开头的通用伙伴 id）。
- 包 id 要匹配 `^[a-z0-9][a-z0-9-]{0,63}$`。
- 最多保存 200 项。
- 值为 `auto` 或格式不对的项会被丢掉，等于「自动」（界面叫 **内置（自动）**）；`none` 保留，表示「不使用」（`none` / `auto` 是保留 id，语音包不能用）。
- 选的包不在本机（商店包被删）时这一项**保留**，按内置处理，重新下载后自动恢复。

`PetService.setTts({ voicePackByCharacter: { id: packId | 'auto' | null } })` 只把这一项合并进去，`auto` 或 `null` 表示删除这一项。

| 通道 | 载荷 | 返回 |
| --- | --- | --- |
| `set-voice-pack`（preload：`setVoicePack(characterId, packId)`，桌宠窗口和设置窗口都有） | `{ characterId, packId: <包 id> \| 'auto' \| 'none' }` | `{ ok, state, settings }`；`{ ok: false, reason: 'unknown-character' \| 'unknown-pack' }` |
| `voice-pack-state`（`voicePackState(characterId)`） | `{ characterId? }`（不传就是当前角色） | `{ ok, state }` |

`state` 的结构：

```text
{ characterId, choice, missing, source, gender, genderSource,
  pack: { id, name, kind, gender, character, engine, voiceId, lines },
  engineVoice: { engine, voiceId, fromPack },
  options: [{ id: 'none' }, { id: 'auto' }, …list()],
  notDownloaded: [{ id, name, style, styleLabel, gender }] }   // 商店里还没下载的风格包（只列出，不能选）
```

切换后立即生效：

- 停掉正在进行的预合成（`endPrewarm`，它还在用旧包的音色），并丢掉正在获取的那一句（`cancel`）。
- 设置保存后会推送 `settings`。桌宠窗口的预合成签名里包含这个角色当前选的包，所以会按新包重新预合成。
- 下一句 `tts-synthesize` 按新的解析结果先查新包的台词，没命中就用新音色合成（不会去别的包里找，避免一句话换个声音）。
- **手动选的包优先**（`packApplies(..., source)`）：`source` 是 `user`（为她选的）或 `default`（我的语音包）时，不管哪个引擎会朗读，录好的台词都先播放；自动解析到的包仍只在引擎一致或没有可用引擎时播放。语音包开关关掉或选了系统语音时都不用。
- 渲染端 `petFx.lastSpeech()` 带 `packId` / `packFile`：播放的是哪个包的哪个文件（引擎合成的为空）。
- 磁盘上的 TTS 缓存不用清：缓存键里包含音色，换了音色自然就是新的键。

`settings.tts.voicePack`（我的语音包）：`'auto'` 或包 id，默认 `'auto'`；不合格式的值按 `auto`（`tts.js normalizeVoicePackId`）。`PetService.setTts({ voicePack: packId | 'auto' | null })`。

| 通道 | 载荷 | 返回 |
| --- | --- | --- |
| `set-user-voice-pack`（preload：`setUserVoicePack(packId)`，桌宠窗口和设置窗口都有） | `{ packId: <包 id> \| 'auto' }` | `{ ok, choice, state（当前角色的）, settings }`；`{ ok: false, reason: 'unknown-pack' }` |

`voice-pack-state` 的 `state` 另带 `userChoice`（生效的我的语音包，`auto` 或包 id）和 `userMissing`。切换后同样立即生效（停预合成、丢掉正在获取的一句；桌宠窗口的预合成签名包含 `voicePack`）。

### 4.0 设置窗口：设置 → 语音包 → 我的语音包

`admin/src/console/pages/Pages.tsx` `MyVoicePack`：下拉「我的语音包」：**自动**（每个角色用自己的专属语音包，没有时按性别用通用男声 / 女声）、**通用语音包**（通用男声 / 通用女声，句数、内置 / 自定义）、**角色的专属语音包**。选中即调用 `setUserVoicePack(packId | 'auto')`，写入 `settings.tts.voicePack`，下一句起生效，重启后保持。下面显示选中的包和「现在陪你的 某某 正在用 …（通用·男 · 我的语音包）」。角色详情 → 语音 里，跟随它的角色「来源」显示「自动 · 跟随我的语音包」，自动项写作「自动（跟随我的语音包）」。e2e：`xvfb-run -a node e2e/run.js user-voice-pack`。

### 4.1 设置窗口：角色详情 → 语音（T-4272）

`admin/src/console/pages/Characters.tsx` `VoiceTab`：

- 下拉「语音包」（T-5095 起）：**不使用（全部用引擎朗读）**、**内置（自动 · 专属或按性别）**（后面写出现在解析到的包，如「现在是 通用·男」）、**风格语音包（已下载）**（商店下载的，标签「风格·可爱」等）、**未下载（先去 商店 → 语音包 下载）**（商店里其余的包，灰掉不能选）、旁边按钮「去商店下载（N 个未下载）」打开 `#/store/voices`；然后是 **专属语音包**（她自己的）、**通用语音包**（通用·男 / 通用·女，用户放进 `userData/voicepacks` 的同 id 包会替换内置的，「重新读取」后出现）、**其他角色的语音包**。选中即调用 `setVoicePack(base, packId | 'auto')`，写入 `settings.tts.voicePackByCharacter`，下一句起生效；重启后保持。
- 「正在用」：包名 + 标签（专属 / 通用·男 / 通用·女 /「某某 的专属」）；「来源」：手动指定 / 自动 · 她有专属语音包 / 自动回退 · 按性别（男/女）用通用语音包；另列台词数、朗读音色（`engineVoice`，标明来自语音包还是她自己的）、音色署名。选的包已不在时显示警告并按自动处理。
- 数据来自角色列表行（`core/roster.js`）：`voicePack`（生效包：`label` `source` `sourceLabel` …）与 `voicePackPick`（`choice` `missing` `gender` `engineVoice` `options[]`，按 专属 → 通用·男 → 通用·女 → 其他 排序）。`main.js adminState` 每次推送都对每个角色调用 `voicePackState`，所以列表卡片的摘要「语音包 通用·男」与详情一致（悬停看包名和句数）。
- e2e：`xvfb-run -a node e2e/run.js voice-pack-switch`（界面切换 → settings.json → 桌宠下一句的 packId → 重启后保持 → 切回自动）。

## 5. 生成内置通用包

```bash
node scripts/voicepack-generate.js --generic --dry-run                  # 列出要录的台词（男女各 138 句）
node scripts/voicepack-generate.js --generic --manifest-only            # 只写 manifest（音色 + pending），不需要 key
node scripts/voicepack-generate.js --generic [--gender male|female]     # 录音（需要 MINIMAX_API_KEY），可以断点续录
```

台词来自 `VP.genericPackLines()`：

- `APP_LINES`
- `dialogue.STAGE_LINES`
- touch-zones 的 `DEFAULT_LINES`
- interaction-voice 的 `DEFAULT_LINES`（拎起 / 甩出 / 接住）
- 通用伙伴模板里不带名字的台词

不包含任何角色自己的台词。录完的台词会用 ffmpeg 转成 32 kbps 的 Opus（和专属包一样）。

## 6. 风格语音包（`kind: "style"`，商店下载）

一个风格语音包 = 一种声音风格，不属于任何角色：同一套**通用台词**（`VP.genericPackLines()`，与通用男女包同一批 138 句）用这个风格的 MiniMax 音色录好，外加一句介绍这个风格的**试听**台词。用户在商店 → 语音包下载后，解压到 `userData/voicepacks/<id>/`，`VoicePacks` 照常加载；它**只会被用户手动选中**（`voicePackByCharacter` 或「我的语音包」`voicePack`），不会被「自动」解析到，也不会顶替同性别的通用包。

### 6.1 manifest 格式

```json
{
  "format": 1,
  "kind": "style",
  "style": "cute",
  "id": "style-cute",
  "name": "可爱 · 甜心少女",
  "gender": "female",
  "version": "1.0.0",
  "description": "软糯甜美的少女音，句尾带点撒娇，适合元气、黏人的桌宠。",
  "engine": "minimax",
  "voiceId": "tianxin_xiaoling",
  "model": "speech-2.8-turbo",
  "params": { "speed": 1.05, "pitch": 1, "vol": 1, "emotion": "happy" },
  "credit": "语音由 AI 合成：MiniMax 甜心小玲（tianxin_xiaoling）",
  "lineSet": "generic",
  "sample": { "text": "嗨嗨～我是软糯糯的可爱语音，以后就由我陪着你啦！", "file": "<sha1>.ogg" },
  "lines": { "<台词原文>": "<sha1 前 16 位>.ogg" }
}
```

| 字段 | 说明 |
| --- | --- |
| `kind` | 固定 `"style"` |
| `style` | 风格键，`^[a-z][a-z0-9-]{1,31}$`；内置风格表见 `src/core/voice-styles.js`（`cute` 可爱 / `yujie` 御姐 / `shaonian` 少年 / `chenwen` 沉稳 / `gaoxiao` 搞笑） |
| `id` `name` `gender` | 同通用包；`id` 约定为 `style-<style>`；**不能有** `character` |
| `version` | `x.y.z`；换音色或台词时升版本 |
| `engine` `voiceId` `model` `params` | 录音用的 MiniMax 音色和参数，按 `validateVoice` 校验；用户为角色选了这个包时，agent 回复等非固定台词也用这个音色合成（`voiceForPack`） |
| `credit` | 署名（AI 合成音色） |
| `lineSet` | `"generic"`：通用台词，任何角色可用；`"character"`：某些角色自己的台词（`packLines`），此时必须写 `appliesTo: ["<角色 id>"]` |
| `sample` | 试听（preview）：`{ text, file }`，文件必须在包里；`VoicePacks#sample(id)` 读出音频 |
| `lines` | 同其他包：台词原文 → 音频文件（文本 sha1 命名） |

**兼容方式**：没有升 `format`（仍为 1），而是新增 `kind: "style"` 和几个只对它生效的字段。`character` / `generic` 包的读取与校验完全不变（旧 manifest、内置包单测照常通过）。比风格包更早的 app 会因 `kind must be one of character, generic` 拒绝并跳过这个文件夹，不影响其他包。

### 6.2 商店目录条目（`src/core/voice-catalog.json`）

`{ "schema": 1, "release": "voices-v1", "voicePacks": [ … ] }`，每项：

```json
{
  "id": "style-cute", "type": "voice-pack", "kind": "style", "style": "cute", "styleLabel": "可爱",
  "name": "可爱 · 甜心少女", "gender": "female", "version": "1.0.0", "description": "…", "credit": "…",
  "engine": "minimax", "voiceId": "tianxin_xiaoling", "model": "speech-2.8-turbo", "params": { … },
  "lineSet": "generic", "lines": 138, "seconds": 290,
  "sample": { "text": "…", "file": "catalog/voices/style-cute.ogg", "seconds": 4.2 },
  "file": "style-cute.zip", "url": "https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/voices-v1/style-cute.zip",
  "bytes": 1234567, "sha256": "<64 hex>"
}
```

- `url` 是默认下载地址（与 `downloadUrl(entry, {})` 相同），归档需先用下面的 `upload-character-catalog.js --voices` 传到 CDN；`file` 是归档文件名，镜像 / 测试服务器按 `<镜像根>/<file>` 取。
- `sample.file` 相对 `src/renderer/`，随 app 一起发，下载前就能试听。
- 归档 `<id>.zip`：`manifest.json` + 所有音频在顶层，解压即是一个可加载的语音包目录。可复现（文件排序、固定时间戳），同样的源文件总是得到同一个 sha256。
- 读取接口（`src/core/catalog.js`，无 Electron 依赖）：`loadVoiceIndex()`、`voicePackEntry(id)`、`listVoicePacks(installed)`（每行带 `installed`、`sizeLabel`）、`downloadUrl(entry, settings)`（默认 `https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/voices-v1/<file>`；`PIXELPET_CATALOG_URL` / `settings.catalogUrl` 可指向镜像或 `file://` 目录）。下载可直接复用 `src/main/catalog.js` 的 `CatalogDownloader`（传 `lookup: voicePackEntry`、`isInstalled`、`install`）：它按 `bytes` 和 `sha256` 校验。

### 6.3 生成与打包

所需配置：

| 配置 | 说明 |
| --- | --- |
| `MINIMAX_API_KEY` | 必需（录音时）。环境变量，或 `~/.config/pixel-pet/minimax.env`、`~/.zshrc`、`~/.bashrc` 里的 `export MINIMAX_API_KEY=…` 行（`scripts/minimax-key.js`）。脚本从不打印 key，报错里出现也会替换成 `***`。`node scripts/minimax-key.js` 只显示在哪找到和长度 |
| `MINIMAX_ENDPOINT` | 可选，默认 `https://api.minimax.cn`（国内站）；国际站填 `https://api.minimax.io` |
| `ffmpeg` / `ffprobe` | 可选但推荐：有 ffmpeg 时每个包录完后转成 32 kbps 单声道 Opus（`.ogg`，单句约 12 KB）；没有就保留 MiniMax 原始 128 kbps mp3。`build-voice-catalog.js` 用 ffprobe 统计时长（没有则记 0） |

```bash
node scripts/voicepack-generate.js --style --dry-run                     # 列出每个风格要录的试听句 + 138 句台词
node scripts/voicepack-generate.js --style                               # 录全部 5 种风格到 catalog/voicepacks/style-*/
node scripts/voicepack-generate.js --style cute,yujie [--rpm 10]         # 只录部分风格
node scripts/build-voice-catalog.js                                      # 打包 out/voice-catalog/*.zip，写 src/core/voice-catalog.json 和试听文件
node scripts/build-voice-catalog.js --check                              # 重新打包并核对索引里的 sha256 / 大小
node scripts/upload-character-catalog.js --voices [--dry-run]            # 上传到 CDN 的 voices-v1（需要 dc CLI 登录）
```

- 限速：默认 `--rpm 10`（MiniMax 国内站免费账号 10 次/分钟），两次请求间隔 ≥ 6.2 秒；遇 1002 / 1039 / 429 退避 20 秒重试，401 / 1008 / 402（key 错或余额不足）直接停止。5 个风格 × 139 次请求约 75 分钟。
- 断点续跑：每录完一句就原子写一次 manifest（`pending` 列出还没录的句子），再次运行跳过已在磁盘上的句子；试听句最先录。
- 加新风格：在 `src/core/voice-styles.js` 的 `STYLES` 加一项（`style` `id` `label` `name` `gender` `description` `voice` `sample`），录音、打包，提交 `catalog/voicepacks/<id>/`、`src/core/voice-catalog.json`、`src/renderer/catalog/voices/<id>.ogg`。

### 6.4 现有风格（voices-v1）

| id | 风格 | 性别 | MiniMax 音色 | 参数 | 试听台词 |
| --- | --- | --- | --- | --- | --- |
| `style-cute` | 可爱 | 女 | `tianxin_xiaoling`（甜心小玲） | speed 1.05, pitch 1, happy | 嗨嗨～我是软糯糯的可爱语音，以后就由我陪着你啦！ |
| `style-yujie` | 御姐 | 女 | `wumei_yujie`（妩媚御姐） | speed 0.95, calm | 嗯，是我。累了就过来靠一会儿吧，姐姐在呢。 |
| `style-shaonian` | 少年 | 男 | `chunzhen_xuedi`（纯真学弟） | speed 1.05, happy | 嘿！我是元气少年音，走，今天也一起加油吧！ |
| `style-chenwen` | 沉稳 | 男 | `Chinese (Mandarin)_Reliable_Executive`（沉稳高管） | speed 0.92, pitch -1, calm | 你好，我是沉稳的声音。事情一件件来，不着急，我陪你。 |
| `style-gaoxiao` | 搞笑 | 男 | `Chinese (Mandarin)_Humorous_Elder`（搞笑大爷） | speed 1, happy | 哎哟喂，我来啦！听我说话保准你乐呵一整天，哈哈哈！ |

每包的句数、时长、大小与 sha256 以 `src/core/voice-catalog.json` 为准。

## 7. 商店 → 语音包：浏览、下载与状态（T-5094）

设置窗口 **商店 → 语音包**（`admin/src/console/pages/Store.tsx` `VoicesShelf`）列出 `src/core/voice-catalog.json` 里的每个风格语音包：名称、风格（Tag）、性别、音色说明（`description` + `音色：MiniMax <voiceId>`）、句数 · 体积 · 版本、署名（`credit`），以及 **试听**（播放随应用附带的 `src/renderer/catalog/voices/<id>.ogg`，不用下载）。

**下载**（`src/main/main.js` `voice-download` → `src/main/catalog.js` `CatalogDownloader` → `src/core/voice-store.js` `installArchive`）：

1. 从 `PIXELPET_CATALOG_URL` / `settings.catalogUrl` / CDN（`dc/ops-assets/archives/pixel-pet/voices-v1/<id>.zip`）下载归档，边下边算 sha256；大小或 sha256 与目录条目不一致就丢弃（`size` / `checksum`）。
2. 解压到 `userData/voicepacks/.<id>-XXXX/`（点开头的文件夹 `VoicePacks` 不读），检查：`manifest.json` 存在、`id` 与条目一致、`kind: "style"`、`validateManifest` 通过（每个音频都在）、除 manifest 与它列出的音频外没有别的文件或文件夹。
3. 通过后写标记 `.catalog.json`（id / version / sha256 / bytes / installedAt），改名为 `userData/voicepacks/<id>/`，`tts.packs.reload()`，立即可选。任何一步失败都删掉临时文件夹，原有的同名包不受影响；错误文案可读，例如「下载的文件校验没通过，已丢弃，请重试」「下载的语音包文件有问题，已丢弃：下载的语音包和商店条目对不上」。

**三态**（`voice-store.js` `deriveState` / `storeRows`，界面卡片 `data-voice-state`）：

| 状态 | 条件 | 卡片 |
| --- | --- | --- |
| 未下载 `remote` | 磁盘上没有合格的 `<id>/` | Tag「未下载」+「下载」；上次失败时卡上显示原因 |
| 下载中 `downloading` | 有进行中的下载（`catalog-progress` downloading / installing） | Tag「下载中」+ 进度条「已下载 N%」/「正在安装…」+「取消」 |
| 已下载 `installed` | `installedIds(userData/voicepacks)` 含它 | Tag「已下载」+「删除」 |

已下载**只看磁盘**，设置里不存下载记录：重启后、手动删掉文件夹后都如实显示。**删除**（`voice-remove`）只删带 `.catalog.json` 标记的文件夹（自己手放的语音包不会被商店删掉）；用到它的角色自动回到「自动」（`resolvePack` 把不存在的选择当 auto）。

**本地可用列表**：① 商店 → 语音包 的「已下载」筛选；② **设置 → 语音包** 表格（`Pages.tsx` `VoicePacksPage`）列出已加载的包，风格包的角色列为「任意角色」，来源列为「商店下载」；在「我的语音包」或 角色详情 → 语音 里选用。

IPC（`src/main/admin-preload.js`）：`voiceStore()` → `{ voicePacks: StoreVoiceRow[], dir }`；`voiceDownload(id)` / `voiceRemove(id)` → `{ ok, reason?, text?, store, settings }`；`voiceDownloadCancel(id)`；进度走 `onCatalogProgress`（id 以 `style-` 开头）。

验证：`node --test test/voice-store.test.js`（安装校验、回滚、磁盘状态、状态推导、下载器 + 本地 HTTP 服务器）；`xvfb-run -a node e2e/run.js voicestore`（本地服务器限速模拟 CDN，截图在 `out/e2e/voicestore/`）。

## 8. 按角色选择 / 切换语音包（T-5095）

设置窗口 → 角色 → 某个角色 → **语音** → **语音包**：

| 选项 | 存到 `settings.tts.voicePackByCharacter[角色]` | 效果 |
| --- | --- | --- |
| 不使用（全部用引擎朗读） | `'none'` | 不查任何语音包，每句都交给引擎，用她自己的音色 |
| 内置（自动 · 专属或按性别） | 删掉这一项（= `auto`） | 我的语音包 > 她的专属包 > 按性别的通用包（和以前一样） |
| 风格语音包（已下载） | 包 id，例如 `style-cute` | 固定台词先播放这个包的录音；包里没有的台词交给引擎（用这个包的音色），不会混用别的包 |
| 未下载 | —（灰掉，不能选） | 点旁边「去商店下载」到 商店 → 语音包 下载，下载完就出现在「已下载」组 |

- **持久化**：写在 `settings.json`，默认 `{}`（每个角色都是内置）；旧设置文件没有这个字段时迁移为 `{}`；重启后保持。
- **即时生效**：选中后桌宠的下一句就按新选择查找（`set-voice-pack` 停预合成、丢掉正在获取的一句，桌宠窗口按新包重新预合成），不用重启。
- **删除正在用的包**：商店里删除后马上回到内置（她的专属包或通用包），角色语音页显示「你选的语音包「…」已经不在了…」并给出「去商店」；选择本身保留，重新下载后自动恢复。删除时会停掉正在获取的那一句和旧包的预合成。

验证：

- 单测 `node --test test/voice-pack-select.test.js`：不使用、查找优先级（A → B 各取各的文件）、手动选的包优先于引擎匹配、未命中回退引擎、删除后回退与恢复、持久化与重启、选择器分组。
- e2e `xvfb-run -a node e2e/run.js voiceselect`（本地服务器充当商店 CDN，不用 Key）：选项 → 去商店下载 A/B → 选 A，喂饱后再喂（「呃……肚子圆滚滚的，吃不下了。」）播放 `userData/voicepacks/style-cute/<文件>` → 切 B 立即来自 `style-yujie` → 不使用 → 重启后仍是 B → 删除 B 回到内置。截图、录屏和日志在 `out/e2e/voiceselect/`。

## 9. 托管、发布与新增风格（T-5096）

### 9.1 资源放在哪

| 内容 | 位置 | 是否进仓库 |
| --- | --- | --- |
| 录音源文件（manifest + 138 句 `.ogg` + 试听句） | `catalog/voicepacks/style-<风格>/` | 是（每包约 1.1–1.5 MB，生成一次后不再改） |
| 商店目录（每包的版本、句数、大小、sha256、下载地址） | `src/core/voice-catalog.json` | 是，随应用发布 |
| 试听音频（下载前就能听） | `src/renderer/catalog/voices/style-<风格>.ogg` | 是，随应用发布 |
| 下载归档 `style-<风格>.zip` | 构建产物 `out/voice-catalog/`；发布后在 CDN `https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/<release>/` | 否（可复现：同样的源文件总是得到同一个 sha256） |

应用只从目录里写的地址下载，并按 `bytes` + `sha256` 校验。地址的优先级：`PIXELPET_CATALOG_URL`（测试 / 镜像）> `settings.catalogUrl`（手动写进 settings.json）> 默认 CDN。镜像只要按 `<镜像根>/<file>` 提供同样的 zip 即可，也可以是 `file://` 目录。

### 9.2 发布一版

```bash
node scripts/build-voice-catalog.js --check                  # 从 catalog/voicepacks 重新打包，核对与 voice-catalog.json 一致
node scripts/upload-character-catalog.js --voices --dry-run  # 只打包核对，列出要上传的文件和地址
dc auth login --token <DC_CLI_TOKEN> --base-url <DC 地址>    # 或设 DC_CLI=<develop-center>/packages/cli/dist/index.js
node scripts/upload-character-catalog.js --voices            # 上传到 dc/ops-assets/archives/pixel-pet/voices-v1/，再逐个下载回来核对
```

- 上传用 Develop Center CLI 的 `dc ops-assets upload --skip-existing`（同 [characters.md](characters.md) 的角色包）。已存在且大小相同的文件跳过；大小不同会报错，不会悄悄覆盖已发布的归档。
- **内容变了（换音色、改台词）就升版本**：改 `src/core/voice-styles.js` 的 `VERSION`，并把 `scripts/build-voice-catalog.js` 的 `RELEASE`（`voices-v1`）改成新的目录（如 `voices-v2`），重新打包、上传，再提交新的 `voice-catalog.json`。旧版应用继续从旧目录下载旧归档。
- 上传后，`curl -I <url>` 应返回 200；然后在应用里用默认地址（不设 `PIXELPET_CATALOG_URL`）下载一次确认。

### 9.3 新增一种风格

1. 在 MiniMax 音色列表里挑一个系统音色（`voiceId`）；运行 `node scripts/minimax-key.js` 确认能找到 Key（只显示位置和长度）。
2. 在 `src/core/voice-styles.js` 的 `STYLES` 末尾加一项：`style`（键，`^[a-z][a-z0-9-]{1,31}$`）、`id`（`style-<键>`）、`label`（商店显示的风格名）、`name`、`gender`（`female` / `male`）、`description`、`voice: { engine: 'minimax', voiceId, label, model, params: { speed, pitch, vol, emotion } }`、`sample`（试听句）。
3. `node scripts/voicepack-generate.js --style <键> --dry-run` 看要录的句子；`node scripts/voicepack-generate.js --style <键>` 录音：
   - 写到 `catalog/voicepacks/style-<键>/`，试听句最先录。
   - 默认每分钟 10 次（`--rpm`），139 次请求约 15 分钟。
   - 中断后再运行会接着录。
   - 有 ffmpeg 时转成 32 kbps Opus。
4. `node scripts/build-voice-catalog.js`：打包 zip，把新条目写进 `src/core/voice-catalog.json`，复制试听文件到 `src/renderer/catalog/voices/`。
5. `npm test`（`test/style-voice-pack.test.js` 校验每个包的 manifest、目录条目和风格表一致），`xvfb-run -a node e2e/run.js voicestore` 看商店卡片。
6. 按 §9.2 上传；提交 `catalog/voicepacks/style-<键>/`、`src/core/voice-styles.js`、`src/core/voice-catalog.json`、`src/renderer/catalog/voices/style-<键>.ogg`。

### 9.4 端到端验证

`xvfb-run -a node e2e/run.js voiceflow` 从空 userData 跑完整流程，本地服务器限速模拟 CDN，不用 Key：

1. 打开朗读。
2. 商店 → 语音包：5 个包都是「未下载」。
3. 下载 可爱 和 少年，每个都经过「下载中」（进度条）再到「已下载」。
4. 本地可用列表：「已下载」筛选、设置 → 语音包、`userData/voicepacks/`。
5. 大肥鱼选 可爱：喂食台词播放 `style-cute` 的录音。
6. 切到 少年：同一句立刻来自 `style-shaonian`。
7. 重启：选择、已下载状态、播放来源都保持。

截图、两段录屏、播放的两段 `.ogg` 和日志在 `out/e2e/voiceflow/`。另有 `voicestore`（试听、校验失败、删除）和 `voiceselect`（不使用、删除正在用的包、其他角色不受影响）两个场景覆盖分支情况。

`voices-v1` 的 5 个归档已于 2026-11-05 上传到 CDN。`xvfb-run -a node e2e/run.js voiceflowcdn` 用真实 CDN 跑同一流程（需要联网，不在 `all` 里）：

- 不启动本地服务器。启动前要确认没有设置 `PIXELPET_CATALOG_URL`，否则场景直接报错。
- 主进程的每次 `net.fetch` 都记到 `out/e2e/voiceflowcdn/fetch-log.json`（地址、状态码、字节数）。F9 断言只请求了这两个包的 CDN 地址，且都返回 200、大小与目录一致。
- 可爱 全速下载（约 0.3 秒），卡片的状态变化由页面里的监听记录在 `f3-states-style-cute.json`。
- 少年 的响应体只放慢到约 250 KB/s（字节不变，仍来自 CDN），便于截到「下载中」。
