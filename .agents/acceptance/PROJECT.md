# PROJECT.md — acceptance adapter for Pixel Pet

## 1. Project summary

Pixel Pet Affection is an Electron desktop pet. The user picks one of the five model-chan characters (DeepSeek 大肥鱼, Claude 克洛蒂, Grok 格萝可, Gemini 杰米, OpenAI 吉皮缇; `src/characters/*.json`; all five default to their 166×226 pixel packs, 大肥鱼's dsh-pet clips are an optional look `dafeiyu-clips`); the app
runs `lh login` (if needed) and `lh agent create`, and the resulting LobeHub
agent is the pet's brain. Layout: `src/core` (pure logic + the `lh` wrapper),
`src/main` (Electron main, `PetService`), `src/renderer` (UI; `packs/` holds the built-in pet packs),
`test/` (unit tests with a fake `lh`), `e2e/run.js` (Playwright-driven app run).

## 2. Environment

- **Start the app:** `npm start` on a desktop; on a headless box `xvfb-run -a node e2e/run.js <scenario>`. Scenarios: fresh, wardrobe, migrate, dafeiyu, busy, space (where the agent lives), advanced (高级设置 holds system-wide settings only; unlock all on the character's page, free resize), packs (pixel sprites, switch/import/remove packs on the character's page), models (⋯ → 角色列表 → character → 模型: each character only offers her vendor's models; the fake lh lists them and records `agent edit -m/-p` in `edits.log`), charpage (⋯ → 角色列表 → a character's page: model/look/个性化设定 (System Role) saved for that character and kept across a restart, unlock on a non-current character, 高级设置 without per-character sections; screenshots in `out/e2e/charpage/`), art (outfit sheet and the character × state sheet), roster (every character × every effect of the shared effects layer, with screenshots and one recording per character in `out/e2e/roster-video/`; `roster <id>` runs one), touch (部位触摸: real clicks on head / chest / butt / feet / hands and more, per-part line, reaction class, marks and affection; drag is not a touch; the 部位触摸 switch falls back to the old pat; screenshots, `*.dom.json`, a recording and `touch-log.txt` in `out/e2e/touch/`), outfit (`outfit [character] [outfit]`, default `claude swimsuit`: a second outfit unlocked by a real stage-up, put on in the wardrobe, idle / walk / lifted measured against daily so she does not jump, kept over a restart, shown from the default pack while 旧版像素 is picked, no console errors; screenshots and `report.txt` in `out/e2e/outfit-<character>-<outfit>/`), vrmimport / vrm (`e2e/vrm.js`: a homemade VRM 1.0 generated into a temp dir by `scripts/make-test-vrm.js` with a restrictive license — 导入 VRM 模型… → 导入确认 / card / 授权信息; then the three-vrm figure under SwiftShader: frame counter, idle frame budget, blink, gaze, 摸摸 / 拖起 / 喂食 / 玩耍, lip sync from her voice-pack line, 18+ off, back to 2D and again, no .vrm in git or build.files; screenshots, `vrm-log.txt` and `vrm-samples.json` in `out/e2e/vrm/`), live (real lh, costs tokens).
- **Stop:** the E2E harness closes the app itself; the `live` scenario deletes the agent it created (also on failure).
- **Required services:** none besides the LobeHub CLI (`lh`) with a logged-in profile for `live`.
- **Skill:** the generic acceptance skill is committed at `.agents/skills/acceptance` (`.claude/skills` links to it for Claude Code). Refresh it with `lh acceptance update` and commit the result; the version is in its `SKILL.md`. This file and its neighbours are the project layer.
- **Already-running detection:** none needed; each run uses a fresh temp data dir (`PIXELPET_DATA_DIR`).
- **Env resolution:** `PIXELPET_TEST=1` (opaque window + debug IPC hooks), `PIXELPET_CLEAR_JWT=1` (dev only: clear an injected narrow `LOBEHUB_JWT`), `LH_BIN` (override the CLI, used for the fake CLI).

## 3. Auth

`lh whoami` answers "am I signed in?". Never run `lh login` during acceptance: it
opens the user's browser. The login screen is verified against `test/fixtures/fake-lh.js`,
which prints the same lines as the real CLI (read from `@lobehub/cli` source).

## 4. Surfaces

Desktop (Electron). Driven through Playwright's `_electron` API, not agent-browser.
CLI behaviour is exercised indirectly through the app.

## 5. Project probes & quick navigation

Test-only IPC (enabled by `PIXELPET_TEST=1`): `window.pet.debugSet(patch)` forces pet
fields (hunger, affection, ...; forcing `affection` re-derives the stage), `window.pet.debugHeartbeat()` runs one proactive tick. The renderer exposes `window.petFx` (always, not only in tests): `state()` returns the current effect state (`state`, `action`, `exact`, `facing`, `flying`), and `cue(name)`, `click()`, `throw(vx, vy)`, `error()`, `face(dir)` trigger effects; `#pet-body[data-state|data-action|data-facing]` mirror it in the DOM.
`#bubble[data-source]` is `llm` or `fallback`, and `data-reason` says why a canned line was used.
`e2e/run.js` writes an answered (all-ages) `settings.json` into each fresh data dir; `launch(env, { gate: true })` skips that so the first-launch 18+ gate shows.
The `wardrobe` scenario drives gate -> pet -> affection -> stage-up notice -> wardrobe -> restart -> adult switch, with named screenshots in `out/e2e/affection-ui/` and the restart log in `restart-log.txt`.
`node e2e/run.js all` includes `live` (real agent, real tokens); run scenarios by name to avoid it.
Every step's outcome (with a note of what it observed) lands in `out/e2e/results.json`; filter it into text evidence instead of re-running.
Before/after pairs for changed UI: check out the base in a worktree, symlink `node_modules`, and run `scripts/capture-views.js` on both revisions (same operations, same views). `scripts/window-position-probe.js` is the regression probe for main-process window moves.
Art: `art/model-chan/README.md` (pipeline, `scripts/art/check_model_chan.py`, `model_chan_preview.py` for the all-states sheet). Python art scripts need Pillow + numpy (system python3 has neither; use a venv).

## 6. Known constraints

- Transparent, always-on-top and drag behaviour cannot be seen under Xvfb (the test window is opaque).
- Every real agent call costs tokens; the `live` scenario makes about five.
- Model replies are non-deterministic; assertions check source and content (for example the remembered name), not exact wording.

## 7. Release gate

Acceptance happens per PR into `canary`, not per release: a PR that changes what the user sees gets its acceptance
round before it merges into canary (publish with `lh acceptance run ingest <round dir> --acceptance
6aeb64e4-6c8b-40c1-919a-c1b189bd95be`, report language zh-CN; the CLI may lack `preflight` / `--dry-run`: check auth
with `lh acceptance run list --json` and validate `result.json` locally) and the owner reviews it there. A 验证报告
request means such a round, not an agent document. Follow-up rounds re-check only affected items under their stable
plan ids. A release needs **no** separate acceptance round: the owner merging into `main` is the release decision
(owner, 2026-10-30). **Merging into main publishes.**

Branches (as LobeHub OSS): day-to-day PRs target `canary` (the default branch; always pass `--repo
rdmclin2/lobehub-pixel-pet-affection` to gh: the `upstream` remote makes gh pick the wrong base). Release: PR
`canary → main` titled `🚀 release: vX.Y.Z`, its description = the version's notes (it becomes the release body) →
merge → `release.yml` tests, builds mac / win / linux with that version (Linux package started under xvfb), creates
the tag and the release with the standard install notes, commits the version to main's `package.json`, and syncs main
back into canary. A feat / fix / hotfix PR merged straight into main releases the next patch the same way; docs / chore /
test PRs into main release nothing (rules: `scripts/release-version.js`). Watch the run (`gh run watch`) and check the
release assets. Auto-update is verified after publishing with the `Self-update check` workflow
(`.github/workflows/update-e2e.yml`), which installs a 0.0.1 build and waits for it to update itself.
