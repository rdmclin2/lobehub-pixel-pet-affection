# PROJECT.md — acceptance adapter for Pixel Pet

## 1. Project summary

Pixel Pet is an Electron desktop pet. The user picks one of three eggs; the app
runs `lh login` (if needed) and `lh agent create`, and the resulting LobeHub
agent is the pet's brain. Layout: `src/core` (pure logic + the `lh` wrapper),
`src/main` (Electron main, `PetService`), `src/renderer` (canvas sprites + UI),
`test/` (unit tests with a fake `lh`), `e2e/run.js` (Playwright-driven app run).

## 2. Environment

- **Start the app:** `npm start` on a desktop; on a headless box `xvfb-run -a node e2e/run.js <fresh|live|art|all>`.
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

## 6. Known constraints

- Transparent, always-on-top and drag behaviour cannot be seen under Xvfb (the test window is opaque).
- Every real agent call costs tokens; the `live` scenario makes about five.
- Model replies are non-deterministic; assertions check source and content (for example the remembered name), not exact wording.
