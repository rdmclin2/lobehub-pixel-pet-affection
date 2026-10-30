# Project living log — mistakes earlier rounds made here

- **Not reading this directory first.** 2026-10-29 a round was first written as a plain agent document; the owner expects an acceptance round in `6aeb64e4…`. Read `PROJECT.md` §7 before writing any report.
- **`pkill -f <pattern>` that matches your own command line** kills the tool shell (exit 144). Kill by PID or process group.
- **`npx @electron/asar extract-file <asar> package.json`** writes into the current directory and overwrites the repo's `package.json`. Extract into a temp dir.
- **Workspace storage block** (`storage_block:overage_not_enabled`): image generation and file evidence fail in the run's workspace. Prefix `LOBEHUB_JWT= LOBEHUB_WORKSPACE_ID=` for `lh generate image` / `lh file upload` (personal scope, per command only; never `lh workspace use`).
- **`lh generate image --width/--height`** returns ServerError for gpt-image-2.5-sunburst; the default canvas is about 1024×1536.
- **Unlock-all opens a confirm dialog**: Playwright scripts must accept dialogs (`page.on('dialog', d => d.accept())`), or the step times out.
- **A green "after" is not enough for art**: put the new frames next to the other characters and on a floor line. Two real problems (a chibi 大肥鱼 among adult proportions, actions floating above the floor) only showed up that way.
- **Other sessions share this machine.** Their roster runs and yours both bind the local HTTP API's fixed port 7340, so N14 (本机 HTTP 接口) times out on some characters when e2e runs overlap; rerun that character alone (`roster <id>`) before calling it a failure (v0.9.0, 2026-10-30). Their `pkill -f e2e/run.js` also kills your shell if your command line contains that text: start long e2e runs from a wrapper script.
- **Do not assume the pet window's width.** The default pet size changed to 125% (#38); "the panel closed" is `innerWidth < 400` (the panel is 460 px), not `<= 240`.
- **Check the merged result, not just each PR.** PRs from parallel sessions merge cleanly but are written against an older master: after a merge, run the whole offline suite and add steps for combinations neither PR saw (e.g. touch on the 旧版像素 packs).
