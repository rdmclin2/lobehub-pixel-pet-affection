# Project living log — mistakes earlier rounds made here

- **Not reading this directory first.** 2026-10-29 a round was first written as a plain agent document; the owner expects an acceptance round in `6aeb64e4…`. Read `PROJECT.md` §7 before writing any report.
- **`pkill -f <pattern>` that matches your own command line** kills the tool shell (exit 144). Kill by PID or process group.
- **`npx @electron/asar extract-file <asar> package.json`** writes into the current directory and overwrites the repo's `package.json`. Extract into a temp dir.
- **Workspace storage block** (`storage_block:overage_not_enabled`): image generation and file evidence fail in the run's workspace. Prefix `LOBEHUB_JWT= LOBEHUB_WORKSPACE_ID=` for `lh generate image` / `lh file upload` (personal scope, per command only; never `lh workspace use`).
- **`lh generate image --width/--height`** returns ServerError for gpt-image-2.5-sunburst; the default canvas is about 1024×1536.
- **Unlock-all opens a confirm dialog**: Playwright scripts must accept dialogs (`page.on('dialog', d => d.accept())`), or the step times out.
- **A green "after" is not enough for art**: put the new frames next to the other characters and on a floor line. Two real problems (a chibi 大肥鱼 among adult proportions, actions floating above the floor) only showed up that way.
