# 语音包：专属语音包与通用男女语音包

语音包是一组提前录好的固定台词（`manifest.json` + 音频文件）。命中台词时直接从磁盘播放，不请求引擎（代码：`src/core/voice-pack.js`）。agent 回复这类不固定的话仍然交给引擎朗读。

## 1. 两种语音包

| `kind` | 含义 | 必填字段 | 内置 |
| --- | --- | --- | --- |
| `character`（省略 `kind` 时就是它，旧包都是这种） | 专属语音包：某一个角色自己的台词和声音 | `format` `id` `name` `character` `lines` | `src/voicepacks/{claude,dafeiyu,gemini,gpt,grok}` |
| `generic` | 通用语音包：跟角色无关的通用台词，按性别分男声 / 女声 | `format` `kind` `gender`（`male` / `female`）`id` `name` `engine` `voiceId` `lines`；**不能有** `character` | `src/voicepacks/generic-male`、`src/voicepacks/generic-female` |

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

1. 用户为这个角色选的包：`settings.tts.voicePackByCharacter[角色 id]`，可以选任何一个已加载的包 → `source: 'user'`
2. 她自己的专属包 → `'own'`
3. 她这个性别对应的通用包 → `'generic'`

如果选的包已经不在了（比如被删了），就按「自动」处理，同时在 `missing` 里返回那个包的 id。新导入、没有专属包的模型会自动用上 `generic-male` 或 `generic-female`。5 个内置角色在「自动」下仍然用各自的专属包，引擎音色也不变（单测 `the five built-in characters resolve exactly as before`）。

引擎音色（`voiceForPack`）的规则：

- 角色文件写了 `voice.tts`：在「自动」下保持不变。
- 用户为她选了别的包：改用那个包的音色，这样录好的台词和引擎合成的话是同一个声音。
- 没有 `voice.tts` 并且回退到了通用包：用通用包的音色。

## 4. 设置与 IPC

`settings.tts.voicePackByCharacter`：`{ [角色 id]: 包 id }`，默认值是 `{}`；没有这个字段的旧设置文件迁移后也是 `{}`。校验（`tts.js normalizeVoicePackPicks`）规则：

- 角色 id 要匹配 `^[a-z][a-z0-9]{1,19}$`（包括 `vrmx…` 开头的通用伙伴 id）。
- 包 id 要匹配 `^[a-z0-9][a-z0-9-]{0,63}$`。
- 最多保存 200 项。
- 值为 `auto` 或格式不对的项会被丢掉，等于「自动」。

`PetService.setTts({ voicePackByCharacter: { id: packId | 'auto' | null } })` 只把这一项合并进去，`auto` 或 `null` 表示删除这一项。

| 通道 | 载荷 | 返回 |
| --- | --- | --- |
| `set-voice-pack`（preload：`setVoicePack(characterId, packId)`，桌宠窗口和设置窗口都有） | `{ characterId, packId: <包 id> \| 'auto' }` | `{ ok, state, settings }`；`{ ok: false, reason: 'unknown-character' \| 'unknown-pack' }` |
| `voice-pack-state`（`voicePackState(characterId)`） | `{ characterId? }`（不传就是当前角色） | `{ ok, state }` |

`state` 的结构：

```text
{ characterId, choice, missing, source, gender, genderSource,
  pack: { id, name, kind, gender, character, engine, voiceId, lines },
  engineVoice: { engine, voiceId, fromPack },
  options: [{ id: 'auto' }, …list()] }
```

切换后立即生效：

- 停掉正在进行的预合成（`endPrewarm`，它还在用旧包的音色），并丢掉正在获取的那一句（`cancel`）。
- 设置保存后会推送 `settings`。桌宠窗口的预合成签名里包含这个角色当前选的包，所以会按新包重新预合成。
- 下一句 `tts-synthesize` 按新的解析结果先查新包的台词，没命中就用新音色合成。
- 磁盘上的 TTS 缓存不用清：缓存键里包含音色，换了音色自然就是新的键。

### 4.1 设置窗口：角色详情 → 语音（T-4272）

`admin/src/console/pages/Characters.tsx` `VoiceTab`：

- 下拉「语音包」：**自动（按性别）**（后面写出现在解析到的包，如「现在是 通用·男」）、**专属语音包**（她自己的）、**通用语音包**（通用·男 / 通用·女，用户放进 `userData/voicepacks` 的同 id 包会替换内置的，「重新读取」后出现）、**其他角色的语音包**。选中即调用 `setVoicePack(base, packId | 'auto')`，写入 `settings.tts.voicePackByCharacter`，下一句起生效；重启后保持。
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
