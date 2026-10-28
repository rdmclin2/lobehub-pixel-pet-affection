# PROJECT.md — acceptance adapter for Pixel Pet

## 1. Project summary

Pixel Pet Affection is an Electron desktop pet. The user picks one of four spirit stones; the app
runs `lh login` (if needed) and `lh agent create`, and the resulting LobeHub
agent is the pet's brain. Layout: `src/core` (pure logic + the `lh` wrapper),
`src/main` (Electron main, `PetService`), `src/renderer` (UI; `packs/` holds the built-in pet packs),
`test/` (unit tests with a fake `lh`), `e2e/run.js` (Playwright-driven app run).

## 2. Environment

- **Start the app:** `npm start` on a desktop; on a headless box `xvfb-run -a node e2e/run.js <scenario>`. Scenarios: fresh, wardrobe, migrate, dafeiyu, busy, space (where the agent lives), advanced (unlock all, free resize), packs (pixel sprites, switch/import/remove packs), art (outfit and pixel action sheets), live (real lh, costs tokens).
- **Stop:** the E2E harness closes the app itself; the `live` scenario deletes the agent it created (also on failure).
- **Required services:** none besides the LobeHub CLI (`lh`) with a logged-in profile for `live`.
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
fields (hunger, affection, ...; forcing `affection` re-derives the stage), `window.pet.debugHeartbeat()` runs one proactive tick.
`#bubble[data-source]` is `llm` or `fallback`, and `data-reason` says why a canned line was used.
`e2e/run.js` writes an answered (all-ages) `settings.json` into each fresh data dir; `launch(env, { gate: true })` skips that so the first-launch 18+ gate shows.
The `wardrobe` scenario drives gate -> pet -> affection -> stage-up notice -> wardrobe -> restart -> adult switch, with named screenshots in `out/e2e/affection-ui/` and the restart log in `restart-log.txt`.
`node e2e/run.js all` includes `live` (real agent, real tokens); run scenarios by name to avoid it.

## 6. Known constraints

- Transparent, always-on-top and drag behaviour cannot be seen under Xvfb (the test window is opaque).
- Every real agent call costs tokens; the `live` scenario makes about five.
- Model replies are non-deterministic; assertions check source and content (for example the remembered name), not exact wording.

## 7. Release gate

Every release gets an acceptance round **before** the tag is pushed: run the scenarios the release
touches, publish with `lh acceptance run ingest <round dir> --acceptance 6aeb64e4-6c8b-40c1-919a-c1b189bd95be`
(report language zh-CN), and send the owner the acceptance link. Tag `v*` only after the owner has
looked at it. Auto-update is verified after publishing with the `Self-update check` workflow
(`.github/workflows/update-e2e.yml`), which installs a 0.0.1 build and waits for it to update itself.
