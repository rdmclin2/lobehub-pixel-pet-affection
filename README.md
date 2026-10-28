# LobeHub Pixel Pet · 好感度版（Affection Edition）

> **派生声明**：本仓库派生自 [ONLY-yours/lobehub-pixel-pet](https://github.com/ONLY-yours/lobehub-pixel-pet)（v0.2.1，MIT，作者 LiJian），保留其完整提交历史、[LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md) 署名。大肥鱼素材仍遵循 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的非商用条款（CC BY-NC-SA 4.0）。
>
> 本派生版把原有的成长系统改造成**好感度系统**：互动提升好感，按阶段解锁分级对话和服饰。所有角色设定为成年人；成人向内容仅限暧昧、调情等非露骨内容，需要首次启动时确认年满 18 岁，并可随时关闭。改造设计见 [docs/affection-design.md](docs/affection-design.md)。以下为上游原 README。

---

# LobeHub Pixel Pet

A pixel-art desktop pet whose brain is a [LobeHub](https://lobehub.com) agent. It needs a LobeHub account and the LobeHub CLI (`lh`). This is a community project that builds on LobeHub, not an official LobeHub product.

1. First launch: four eggs (fire / water / grass / whale). Pick one.
2. The app calls the LobeHub CLI: `lh login` (device-code login in your browser, skipped if you are already logged in), then `lh agent create` to make **your** pet's agent, with the species personality baked into its system role.
3. The pet lives on your desktop: it gets hungry, tired and bored, grows closer to you through an affection system (陌生 → 熟悉 → 亲近 → 暧昧 / 知己 → 恋人 / 挚友, see `docs/affection-design.md`), remembers what you tell it, and speaks up on its own.

The fire, water and grass pets are pixel art generated in code (`src/renderer/sprites.js`), with no third-party assets. The fourth, **大肥鱼 (Dafeiyu)**, uses animations from a community project; see [Credits](#credits). The pet window is small and shows only the pet; the bars, buttons and chat box appear while the pointer is over it.

## What the pet can do (v0.2)

- **Works first, charms second.** The persona is flexible: simple jobs (look something up, search the web, calculate, translate, write) are just done, in the pet's voice. Replies aim for 50 characters or fewer, and big tasks are done one step at a time. Longer replies scroll inside the bubble.
- **Hover only.** Bars, name line, buttons and the chat box show **only while the pointer is over the pet window**. Moving away hides everything, even an open chat box: the draft and attached files are kept and come back on the next hover (the hidden box also gives up keyboard focus). To paste a picture, hover the pet first.
- **Busy means busy.** While the pet is thinking or working, only the pet and a "思考中" bubble show; the bars, buttons and chat box stay hidden even on hover, and care actions are refused. While it works, hovering shows only a **■ 停止 (Stop)** button; click it (or press **Esc**) to interrupt, including while the device is being connected.
- **Pictures.** Paste with Ctrl/⌘+V, drag an image onto the window, or use the 📎 button (up to 4 images, 8 MB each). The picture is uploaded with `lh file upload`, attached to a user message in the pet's topic, and the next agent run sees it.
- **Use this computer.** The hatch screen has an option (on by default) to let the pet use your computer. It works through LobeHub's device mechanism: when you claim a pet, and every time the app starts, it makes sure the `lh connect --daemon` background process is running (it checks `lh connect status` first, because the CLI refuses to start a second one), finds this machine's online device, and binds the pet's agent to it (`agencyConfig.boundDeviceId`, `executionTarget: local`). If the daemon cannot start but the LobeHub desktop app already has this computer online, the pet keeps working through that and tells you. Toggle it from the ⋯ menu; turning it off unbinds the agent but leaves the daemon running, because it may also be yours.
- **Drop files on the pet.** Any file or folder dragged onto the window (or pasted from Finder) is handed over **by path only**: nothing is uploaded, and the agent reads it through the bound device. If computer access is off, the app asks to turn it on first. Screenshots from the clipboard have no path, so they are uploaded as pictures for the model to look at.

> **Security.** A bound device lets the agent read and write files and run commands as your user. `lh` does not sandbox this: a working directory is only the default for relative paths. Anything the pet reads (web pages, files, images) could contain instructions meant to trick the model. The device is also account-wide while connected. Turn the option off if you do not want this. For automated tests, `PIXELPET_NO_CONNECT=1` forbids starting `lh connect`.

## Download (macOS)

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on a macOS runner: a **universal** build, so one file runs on both Apple Silicon and Intel.

1. Open the repository's **Releases** page and download `PixelPet-<version>-mac-universal.dmg` (or the `.zip`).
2. Drag **Pixel Pet** into Applications.
3. The app is **not signed or notarized** (no Apple developer certificate), so macOS will refuse the first launch. Either right-click the app and choose **Open**, or run:
   ```bash
   xattr -cr "/Applications/Pixel Pet.app"
   ```
4. Install the LobeHub CLI once, because the pet's brain runs through it: `npm install -g @lobehub/cli`. The app finds `lh` itself even when launched from Finder (Homebrew, nvm, fnm, volta and similar locations are searched).

To cut a release: `git tag v0.1.1 && git push origin v0.1.1`. To build without releasing, run the workflow manually from the Actions tab; the files are kept as a run artifact. Locally on a Mac: `npm run dist:mac`.

## Download (Windows 10/11, x64)

The same Releases page has `PixelPet-<version>-win-x64-setup.exe` (installer) and `PixelPet-<version>-win-x64.zip` (unzip and run `Pixel Pet.exe`).

1. The app is **not code-signed**, so Windows SmartScreen will warn: click **More info → Run anyway**.
2. Install Node.js and the LobeHub CLI (`npm install -g @lobehub/cli`); `lh --version` must work in a terminal.
3. On Windows `lh` is a `.cmd` shim, which Node cannot start without a shell, and a shell would be a command-injection risk for the pet's prompt text. The app therefore reads the shim, finds the JS entry it launches, and runs that directly with its own Electron binary (`ELECTRON_RUN_AS_NODE`), with no shell involved.
4. **Status:** the Windows build is produced by CI and its contents were inspected, but it has not been run on a real Windows machine by the author. The launch logic is covered by unit tests only.

## Run from source

Requires Node 20+, the [LobeHub CLI](https://www.npmjs.com/package/@lobehub/cli) (`lh`) on `PATH`, and a desktop session.

```bash
npm install
npm start
```

## How it is built

```
Electron renderer (canvas sprites, UI)  ⇄ preload IPC ⇄  PetService  ⇄  LhClient ⇄ `lh` CLI ⇄ LobeHub
                                                         ├─ pet-state   needs, growth, sleep (pure, tested)
                                                         ├─ persona     system role + per-message [状态] block
                                                         ├─ proactive   when to speak + hourly LLM budget
                                                         └─ store       ~/.config/pixel-pet/pet.json
```

- **Harness boundary** — `src/core/lh-client.js` is the only file that knows about LobeHub. It uses `lh whoami`, `lh login`, `lh agent create`, `lh agent run --json` and `lh agent delete`. Replacing the harness means replacing this file (`whoami/login/createAgent/run/deleteAgent`).
- **Memory** — every turn reuses one LobeHub *topic* (`-t <topicId>`), so the pet's long-term history lives in LobeHub.
- **Pet feel** (borrowed from the "大肥鱼" community pets): a persona prompt, a state block injected in every message so the pet reacts to how it actually feels, and proactive lines (hungry / bored / morning / evening greetings) with a cooldown and an hourly LLM-call budget. When the agent is unreachable or the budget is spent, the pet falls back to canned in-character lines, so it never goes silent.
- Care actions (feed / play / sleep / pat) are local and free; only chat and proactive lines call the agent.

Cost note: each agent call goes through the LobeHub workspace's agent runtime, which can attach a large default context (tens of thousands of input tokens in our runs). The budget in `src/core/proactive.js` (`maxLlmPerHour`, default 6) keeps unattended spending bounded.

## Test

```bash
npm test                              # unit tests (fake `lh`, no network)
xvfb-run -a node e2e/run.js all       # drives the real Electron app; `live` uses your real `lh` login
```

`e2e/run.js live` creates a real agent in your LobeHub workspace and deletes it again at the end (also on failure). Screenshots land in `out/e2e/`.

## Known gaps

- Binding the agent to your computer uses `lh agent edit --agency-config-file`, which old `lh` releases do not have (it is missing in 0.0.44 and earlier). With such an lh the pet falls back to naming the device on every run (`--device <id>`) and tells you to update: `npm install -g @lobehub/cli@latest`. The fallback has only been tested with a fake CLI.
- Reading and writing local files through the bound device has only been tested with a fake CLI by the author; real behaviour depends on LobeHub's device mechanism.
- The macOS build is unsigned and has only been built by CI, not opened on a real Mac by the author. Linux and Windows builds are not set up.
- The real `lh login` browser flow has not been exercised end to end: tests use a fake `lh` that prints the same lines the real CLI does (read from the CLI source).
- Transparent / always-on-top / drag behaviour on a real desktop has not been visually verified (tests run under Xvfb with an opaque window).
- Pet needs only persist locally; "Release" optionally deletes the LobeHub agent too.

## Credits

The **大肥鱼 (Dafeiyu)** animations (`src/renderer/assets/dafeiyu/`) come from the open-source project **dsh-pet** by PC2005-cloud: <https://github.com/PC2005-cloud/dsh-pet>.

- The code of dsh-pet is MIT-licensed. Its assets are free for open-source use but **may not be used commercially**.
- The character is a community re-creation of DeepSeek's "大肥鱼" (not an official DeepSeek image), licensed **CC BY-NC-SA 4.0**. The prototype "溟月" is by Bilibili @上善无形; the DeepSeek maid-whale design is by Bilibili @ZipZipPipe.
- Because of those terms, do not sell this app or ship it commercially while it includes these files. Remove `src/renderer/assets/dafeiyu/` and the `dafeiyu` entry in `src/core/species.js` first.

Full text: `src/renderer/assets/dafeiyu/NOTICE.md`.

## License

The code is MIT, see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). The 大肥鱼 animations in `src/renderer/assets/dafeiyu/` are **not** MIT: they are non-commercial only (see [Credits](#credits)), so builds that include them are for non-commercial use.
