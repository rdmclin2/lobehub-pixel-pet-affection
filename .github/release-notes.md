> **成人向（18+）应用**：包含面向成年人的暧昧互动内容（不含露骨内容）。首次启动会确认是否年满 18 周岁，成人向内容可随时在“⋯”菜单关闭。内容边界与合规审查见 README 和 `docs/compliance-review.md`。

## 安装（macOS，Intel 与 Apple 芯片通用）

1. 下载 `.dmg`（或 `.zip`），把 **Pixel Pet Affection** 拖进“应用程序”。
2. 应用没有苹果开发者签名，首次打开会被拦截：右键点应用选“打开”，或执行 `xattr -cr "/Applications/Pixel Pet Affection.app"`。
3. 先装 LobeHub CLI：`npm install -g @lobehub/cli`，宠物的大脑通过它运行。

## 安装（Windows 10/11，x64）

1. 下载 `-win-x64-setup.exe` 运行安装（或下载 `-win-x64.zip` 解压后直接运行 `Pixel Pet Affection.exe`）。
2. 应用没有代码签名，Windows SmartScreen 会拦：点“更多信息” → “仍要运行”。
3. 先装 Node.js 和 LobeHub CLI：`npm install -g @lobehub/cli`（装好后在终端能执行 `lh --version`）。
4. Windows 版目前只做了构建，没有在真机上完整验证，遇到问题请开 issue。

## 安装（Linux，x64）

1. 下载 `-linux-x64.tar.gz` 解压，运行其中的 `pixel-pet-affection`。
2. 提示 `chrome-sandbox ... is not configured correctly` 时，见 README 的使用说明（设置沙盒助手权限，或加 `--no-sandbox` 启动）。
3. 先装 Node.js 和 LobeHub CLI：`npm install -g @lobehub/cli`。tar.gz 版不会自动更新，有新版本时菜单里会给出下载页。

## 使用这台电脑（默认勾选，注意权限）

唤醒页的“使用这台电脑”默认开启：应用会在认领和每次启动时确保 `lh connect --daemon` 在后台运行，并把宠物绑定到你的这台电脑。绑定后宠物能读写文件、搜索内容、运行命令，**权限等同你的账号，不是沙盒**；把文件拖给它时只传路径、不上传。不想要的话，唤醒时取消勾选，或在“⋯”菜单里随时关闭。

## 素材说明

“大肥鱼”的动画来自开源项目 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：素材仅限非商业使用，形象为社区二创（非 DeepSeek 官方），授权 CC BY-NC-SA 4.0。详见 README 的 Credits。请勿商用。

---
