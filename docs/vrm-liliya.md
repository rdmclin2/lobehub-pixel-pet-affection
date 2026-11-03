# 用莉莉雅 liliya 体验 VRM 独立交互（素材放置、烘焙、导入与授权）

本文说明如何在**自己的电脑上**把素材包准备好、导入莉莉雅（liliya）模型，看到 VRM 独立的姿势、idle 待机和交互反应。设计细节见 [vrm-motion-system.md](vrm-motion-system.md)。

> **仅限个人使用。** 模型、姿势、动作素材都不在仓库里，也不随安装包分发。它们只存放在你本机的目录（`~/vrm-assets/` 和应用用户数据目录）中。不要把它们提交到 git、放进安装包、上传或转发。

## 1. 下载并放置素材

把五个素材包下载到 `~/vrm-assets/zips/`，再分别解压到 `~/vrm-assets/<包名>/`：

| 包 | 下载地址 | 解压到 | 本期用途 |
|---|---|---|---|
| postures | https://hub-apac-1.lobeobjects.space/docs/1218d0d717192994df31846d2f6adf2c.zip | `~/vrm-assets/postures/` | 姿势（Mixamo 静态 FBX） |
| motions | https://hub-apac-1.lobeobjects.space/docs/faab906b8e2501fdf85d1ed7776ee621.zip | `~/vrm-assets/motions/` | 备选（VMD，P1） |
| mixamo | https://hub-apac-1.lobeobjects.space/docs/fcf2f1201b9623b26330eba6c59bb970.zip | `~/vrm-assets/mixamo/` | idle 与交互反应 |
| dances | https://hub-apac-1.lobeobjects.space/docs/f39a10e3648fcd6c3f9e8a05d94cad17.zip | `~/vrm-assets/dances/` | 只保存，本期不接入 |
| models | https://hub-apac-1.lobeobjects.space/docs/c9ad888755d06beca7226fe07d33c159.zip | `~/vrm-assets/models/` | 莉莉雅 liliya、男性对照 vroid.vrm 等 |

```bash
mkdir -p ~/vrm-assets/zips && cd ~/vrm-assets/zips
curl -L -o postures.zip https://hub-apac-1.lobeobjects.space/docs/1218d0d717192994df31846d2f6adf2c.zip
curl -L -o motions.zip  https://hub-apac-1.lobeobjects.space/docs/faab906b8e2501fdf85d1ed7776ee621.zip
curl -L -o mixamo.zip   https://hub-apac-1.lobeobjects.space/docs/fcf2f1201b9623b26330eba6c59bb970.zip
curl -L -o dances.zip   https://hub-apac-1.lobeobjects.space/docs/f39a10e3648fcd6c3f9e8a05d94cad17.zip
curl -L -o models.zip   https://hub-apac-1.lobeobjects.space/docs/c9ad888755d06beca7226fe07d33c159.zip
for p in postures motions mixamo dances models; do mkdir -p ../$p && unzip -q -o $p.zip -d ../$p; done
```

解压后，莉莉雅模型位于 `~/vrm-assets/models/模型文件/莉莉雅/liliya.vrm`，男性对照模型位于 `~/vrm-assets/models/模型文件/vroid.vrm`（VRoid 男性，作者 Calvin Meng）。

> 任何素材目录都**不能放在仓库目录内**。烘焙脚本、主进程和验收脚本发现路径在仓库内时会直接拒绝使用。`.gitignore` 和 `build.files` 也排除了 `.vrm/.vrma/.fbx/.vmd/.bvh/.pmx`。

## 2. 烘焙动作库（FBX → `.vrma`）

```bash
node scripts/vrm-bake.js --assets ~/vrm-assets --out ~/vrm-assets/baked
```

该命令会按 `src/core/vrm-library.json` 中的清单（只含文件 id 和参数，不含素材本身），把女性（female）和男性（male）两套姿势、idle 和反应烘焙成 `.vrma`，连同 `library.json` 一起写到 `~/vrm-assets/baked/`。首次运行会把 three.js 临时安装到系统临时目录。

应用读取动作库的顺序如下，命中第一个就使用：

1. 环境变量 `PIXELPET_VRM_MOTIONS_DIR`；
2. 应用用户数据目录下的 `vrm-motions/`（Linux 为 `~/.config/Pixel Pet Affection/vrm-motions/`，macOS 为 `~/Library/Application Support/Pixel Pet Affection/vrm-motions/`）。可以把 `~/vrm-assets/baked/` 的内容复制到这里；
3. 开发运行（`npm start`）时还会读取 `~/vrm-assets/baked/`。

## 3. 在应用里导入莉莉雅

1. 运行应用：`npm start`（或 `PIXELPET_VRM_MOTIONS_DIR=~/vrm-assets/baked npm start`）。
2. 选好角色并孵化后，把鼠标移到桌宠上，依次点 **⋯ → 角色列表 → 当前角色的「打开」**，进入角色页的 **外观** 区。
3. 点 **导入 VRM 模型…**，选择 `~/vrm-assets/models/模型文件/莉莉雅/liliya.vrm`。
4. 应用会弹出 **导入确认卡**，显示从模型文件读取的授权：VRM 0.x · Other，个人可商用（法人/企业不可）、不可再分发、禁止修改、需署名，以及禁止性表现、暴力等条款。确认后点 **使用这个模型**。
5. 提示「已导入 VRM 模型「liliya」并换上」，桌宠即切换为 3D 莉莉雅。模型会被复制到用户数据目录下的 `packs/vrm-<角色>-liliya/`，只存在于本机。

导入后：

- **风格**根据模型自动推断：liliya 的胸部挂了 SpringBone，推断为 `female`；vroid.vrm 的肩宽与胯宽之比为 1.57，推断为 `male`。画布上的 `data-style` 会显示推断结果和来源（例如 `female (meta)`）。也可以在包的 `pack.json` 里写 `vrm.style: "male"` 强制指定。
- **姿势**：在角色页外观区，VRM 卡片下的「姿势」下拉菜单可选择：自动 / 放松站 / 叉腰站 / 害羞站 / 俏皮站 / 坐着 / 靠坐（对应 `stand.relaxed / stand.confident / stand.shy / stand.playful / sit.rest / sit.doze`）。选择会保存，重启后仍然有效。选「自动」时，姿势由 idle 调度决定，无人理会 3 分钟后会自己坐下。
- **交互**：点击头、脸、手、肚子、胸等部位，拖起再放下，聊天（思考/说话），喂食，进化或孵化时庆祝，都会触发 VRM 专属的反应动作，与像素角色的 CSS 动画互不影响。
- 回到像素形象：在外观里选回任意像素包即可，VRM 模型保留在用户数据目录中。删除时点该外观卡片上的「移除」。

## 4. 授权与个人使用说明

- 莉莉雅 liliya.vrm 的授权（读自模型 meta）：允许所有人使用，个人可商用，法人/企业不可商用，**不可再分发**，**禁止修改**，需要署名，禁止性表现和暴力表现。应用的处理方式：
  - 只在本机运行时驱动表情和姿态，**不改写模型文件**；
  - 模型**不进仓库、不进安装包、不可导出/分享**；
  - 在 18+ 内容和成人服饰下不可用（由应用强制）；
  - 外观页显示作者（liliya 的 meta 没有填写作者，显示为「未署名」）。
- vroid.vrm（男性对照）：Redistribution_Prohibited，仅限个人非商业使用，仅作者本人可扮演，作者 Calvin Meng。
- 素材包中的 Mixamo / MMD 动作和 Genshin 系二创模型同样只用于本机个人体验，不随项目发布。

## 5. 本机复现验收

```bash
M=~/vrm-assets/models/模型文件
# 姿势 / idle / 男女对比（导入流程截图、每个姿势截图、45 s idle GIF、姿势切换 GIF、录屏）
xvfb-run -a -s '-screen 0 1280x800x24' node .agents/acceptance/scripts/vrm-motion-real-acceptance.js . ~/vrm-motion-evidence \
  --motions ~/vrm-assets/baked --model $M/莉莉雅/liliya.vrm --male $M/vroid.vrm
# 每种交互反应（GIF + 峰值帧 + 逐帧日志 + 男女对照图）
xvfb-run -a -s '-screen 0 1280x800x24' node .agents/acceptance/scripts/vrm-reactions-real-acceptance.js . ~/vrm-motion-evidence/reactions \
  --motions ~/vrm-assets/baked --model $M/莉莉雅/liliya.vrm --male $M/vroid.vrm
```

以上两个脚本走的是真实的「导入 VRM 模型…」界面流程。原生文件选择框由测试钩子 `debugNextOpen` 直接给出路径，其余步骤都是真实点击。
