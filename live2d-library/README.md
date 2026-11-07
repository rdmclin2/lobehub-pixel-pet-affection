# Live2D 本地素材库（不进商店）

这里存放从网上收集的第三方 Live2D 模型（目标约 100 套），用来评估质量、本地试用，并为以后接入桌宠做准备。
**它只是开发者本机的素材库：不属于应用安装包，不属于角色商店，也不进公开仓库。**

## 1. 存放位置

```
live2d-library/
├── README.md              本文件（提交）
├── manifest.json          机器可读清单，每套模型一条（提交）
├── manifest.schema.json   清单的 JSON Schema（提交）
├── manifest.example.json  两条字段完整的示例条目（提交，不是真实清单）
├── models/<id>/           模型原样解压（git 忽略，只在本地）
├── _downloads/<id>.<ext>  原始压缩包 zip / 7z / rar（git 忽略，只在本地）
└── previews/<id>.png      预览缩略图（git 忽略，只在本地；清单里的 previewPath 指向这里）
```

- `<id>` 用 kebab-case，带来源前缀：`gh-`（GitHub）、`bili-`（Bilibili）、`forum-`（Live2D 论坛）、`qq-`（QQ 群）、
  `steam-`（Steam 创意工坊）、`booth-`、`nizima-`、`official-`（Live2D 官方示例）、`other-`。例：`official-hiyori`、`gh-xxx-shizuku`。
  同一个 `<id>` 同时是 `models/` 下的目录名和 `_downloads/` 下压缩包的文件名（去掉扩展名）。
- `models/<id>/` 里放**原样解压**的内容，不改名、不删文件；一个目录里有多个 `*.model3.json`（换装 / 变体）也可以。
- `.gitignore` 忽略 `live2d-library/models/`、`live2d-library/_downloads/`、`live2d-library/previews/`。
  预览图也是第三方美术的复制品，同样只存本地；可以提交的“缩略图清单”就是 `manifest.json` 里的 `previewPath`。

## 2. 为什么不能放进 `catalog/packs/`、不能进商店

1. **授权**：大部分模型的条款是“免费使用、禁止二次配布/转载/贩卖”，或者需要单独向作者申请授权，或者是付费素材。
   本仓库是**公开仓库**，提交即等于向全网再分发；商店会把模型打包上传到公共 CDN，同样是再分发。
2. **扫描路径**：`catalog/packs/<id>/` 和 `catalog/clips/<id>/` 会被 `scripts/build-character-catalog.js`
   打包成商店的下载包并写进 `src/core/character-catalog.json`，`scripts/upload-character-catalog.js`（`npm run catalog:upload`）
   再把它们上传到 CDN。`scripts/build-store-assets.js` / `upload-store-assets.js` 读的是 `~/vrm-assets`（`--src`）。
   electron-builder 只打包 `src/**` 和 `package.json`。`live2d-library/` 在仓库根，以上脚本和安装包都扫不到它
   （`test/live2d-library.test.js` 检查这几个脚本和 `build.files` 都没有引用本目录）。
3. 某套模型以后若要进商店，必须先拿到作者对“再分发 + 在应用中使用”的书面授权，把授权写进 `licenseNote`，
   再单独走 `catalog/packs/` 的上架流程（参照 `catalog/packs/dafeiyu-live2d/NOTICE.md`），**不是**把本目录的文件拷过去。

## 3. 清单字段（`manifest.json`）

`manifest.json` 为 `{ "schema": 1, "updatedAt": "YYYY-MM-DD", "entries": [ ... ] }`，完整条目示例见 `manifest.example.json`。标 **auto** 的字段由校验脚本测量回填，手写会被覆盖。

| 字段 | 含义 |
| --- | --- |
| `id` | kebab-case + 来源前缀，见 §1 |
| `name` | 模型 / 角色名 |
| `channel` | `github` \| `bilibili` \| `forum` \| `qq` \| `steam-workshop` \| `booth` \| `nizima` \| `official` \| `other` |
| `sourceUrl` | 发布页 URL（不是直链下载地址也可以） |
| `author` | 作者 / 建模师 / 原画，能查到几个写几个 |
| `downloadStatus` | `downloaded`（已在 `models/<id>/`）\| `failed` \| `not-downloadable` \| `login-required` \| `paid` \| `pending` |
| `failReason` | 非 `downloaded` / `pending` 时必填：失败原因、需要登录、价格等 |
| `license` | 授权类型：如 `MIT`、`CC BY-NC 4.0`、`Live2D Free Material License`、`作者自定条款`、`unknown` |
| `licenseNote` | 条款原文摘录或条款链接（逐项标注授权情况的依据） |
| `licenseFlags` | `commercial` 可商用、`redistribute` 可再分发、`modify` 可修改、`attribution` 需署名、`needsAuthorization` 使用前需向作者申请；每项 `true` / `false` / `"unknown"` |
| `cubismVersion` | **auto**：`2` \| `3` \| `4` \| `5` \| `"unknown"`，读 `.moc3` 头部版本字节（1–2 → 3，3–4 → 4，5–6 → 5）；`.model.json` 为 2 |
| `appSupported` | **auto**：Cubism 3+ 为 `true`（应用内置 Cubism 4 运行时，`src/main/packs.js` 拒绝 Cubism 2） |
| `files` | **auto**：`models/<id>/` 下所有 `*.model3.json` / `*.model.json` 的相对路径 |
| `hasPhysics` | **auto**：引用了物理文件 |
| `expressionCount` | **auto**：表情文件（`.exp3.json`）数 |
| `expressionParamCount` | **auto**（附加字段）：`cdi3.json` 里直接驱动表情的参数数（`PARAM_EXP*`、名称含“表情”）。大肥鱼没有 `.exp3.json`，表情就是这类参数，由应用实时驱动 |
| `motionCount` | **auto**：动作文件数 |
| `textureMaxSize` | **auto**：最大贴图边长（px，读 PNG / JPEG 头） |
| `sizeBytes` | **auto**：`models/<id>/` 解压后总字节 |
| `missingFiles` | **auto**（附加字段）：模型引用了但不存在的文件；非空时校验失败 |
| `sha256` | **auto**：`_downloads/<id>.<ext>` 原始压缩包的 sha256；没有压缩包时保留手填值 / `null` |
| `qualityTier` | **auto**：`A` / `B` / `C`，见 §4；设 `qualityTierManual: true` 可保留人工评定 |
| `previewPath` | 相对 `live2d-library/` 的预览图，如 `previews/<id>.png`；为空时脚本自动找 `previews/<id>.png`、`models/<id>/preview.png` |
| `notes` | 其它说明：变体、改动、已知问题 |

一个模型目录还没有清单条目时，脚本会建一条（`channel` 按前缀推断，授权字段为 `unknown`），并提示补全来源和授权。

## 4. 质量档

| 档 | 判定（脚本自动） |
| --- | --- |
| **A** 接近大肥鱼 | Cubism 4 / 5、有物理、最大贴图 ≥ 2048、有表情（`.exp3.json` 或表情参数），且引用文件齐全 |
| **B** 能用 | Cubism 3+（应用能加载），引用齐全，但缺 A 的某一项（如 Cubism 3、无物理、贴图 < 2K、无表情） |
| **C** 暂不能用 | Cubism 2、版本不明、引用文件缺失、目录里找不到模型文件，或尚未下载 |

### 质量基准：大肥鱼（`catalog/packs/dafeiyu-live2d`，只读测量，未复制进本库）

```
$ node scripts/live2d-library-check.js --sample catalog/packs/dafeiyu-live2d
sample (read-only): catalog/packs/dafeiyu-live2d
  model/medium.model3.json  Cubism 5 (moc 5.0)
    physics yes · expressions 0 (.exp3) + 8 (params) · motions 0 · textures 4096×4096 · tier A
  → cubismVersion 5 · appSupported true · hasPhysics true · expressionCount 0 · expressionParamCount 8 · motionCount 0 · textureMaxSize 4096 · sizeBytes 5397992 · qualityTier A
```

| 指标 | 大肥鱼 |
| --- | --- |
| Cubism / moc 版本 | 5（moc3 v5 = Cubism 5.0） |
| 物理 | 有：26 组物理（`PhysicsSettingCount` 26，输入 69 / 输出 118）：头发、裙子、蝴蝶结、手臂、耳鳍、尾巴、眼睛 |
| 表情 | 0 个 `.exp3.json`，8 个表情参数 `PARAM_EXP1`–`PARAM_EXP8`（脸红、眯眼、X 眼、流口水等，由 `pack.json` 的 `faces` 驱动） |
| 动作 | 0（待机、眨眼、口型、挥手由应用实时驱动） |
| 参数 / 部件 | 174 个参数，76 个部件 |
| 贴图 | 1 张 4096 × 4096 |
| 解压体积 | 5,397,992 字节（约 5.1 MB） |
| 授权 | 免费使用、禁止贩卖（见其 `NOTICE.md`） |
| 档 | **A** |

收集时的参照：A 档要像大肥鱼一样有成套物理和可驱动的表情、贴图清晰（≥ 2K）。动作数不进判定（应用自己驱动动作），只作参考。

## 5. 校验脚本

```bash
node scripts/live2d-library-check.js            # 校验并回填 manifest.json（npm run live2d:check）
node scripts/live2d-library-check.js --dry-run  # 只校验，不写 manifest.json
node scripts/live2d-library-check.js --json     # 机器可读输出
node scripts/live2d-library-check.js --sample <模型目录>   # 只读测量任意目录（如大肥鱼），别名 --ref
```

脚本只用 Node 内置模块。它遍历 `models/<id>/`，解析每个 `*.model3.json` / `*.model.json`，检查 moc、贴图、物理、pose、
显示信息、表情、动作、声音等引用文件是否齐全，识别 Cubism 版本，统计物理 / 表情 / 动作 / 贴图尺寸，回填 §3 的 auto 字段，
校验所有条目的字段取值，最后输出汇总：条目总数、已下载、可下载（downloaded + pending + failed）、Cubism 3+ 数、A / B / C 分布、
各状态 / 渠道数量、仍需授权的数量。清单字段不合法、已下载的模型缺文件、`downloaded` 但目录不存在时退出码为 1。

## 6. 接入桌宠（本地试用）

- 应用支持 Cubism 3 / 4 / 5（`.model3.json`），**不支持 Cubism 2**；先看 `appSupported`。
- 本地试用：在应用里 **外观 → 导入 Live2D 模型…**，选 `models/<id>/` 里的 `.model3.json`（或它所在的文件夹）。
  应用把模型复制到 `<userData>/packs/<id>`，只在这台电脑上可见，不经过仓库和商店。一个目录里有多个模型时直接选其中一个 `.model3.json`。
- 导入时应用从模型的表情文件读出表情映射（`pack.json` 的 `live2d.faces`）。要像大肥鱼那样细调（高度、半身腰线、
  手臂 / 尾巴 / 耳朵参数映射、用参数做表情），编辑导入后的 `<userData>/packs/<id>/pack.json` 的 `live2d` 段，
  写法参照 `catalog/packs/dafeiyu-live2d/pack.json`；参数名在模型的 `*.cdi3.json` 里查。
- 想做成内置或可下载角色时，回到 §2 第 3 条：先取得授权，再走 `catalog/packs/` 的流程。

## 7. 规则

- 不要把 `models/`、`_downloads/`、`previews/` 下的任何文件 `git add -f`。
- 不要把本目录下的模型复制到 `catalog/packs/`、`catalog/clips/`、`src/renderer/packs/`，也不要对它运行 `catalog:build` / `catalog:upload` / `store:build` / `store:upload`。
- 授权不明的模型 `licenseFlags` 一律写 `"unknown"`，`needsAuthorization` 不为 `false` 的模型只做本地个人试用。
