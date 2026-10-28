# T-1160 round 2 acceptance evidence (pixel-pet model-chan)

Evidence only, not code. Captured 2026-10-29 for master 553e318 (PR #19, adds 杰米 Gemini-chan).
LobeHub workspace storage was full, so the screenshots and recordings live on this branch.

- `gemini-clean/`: real Electron app, fresh `git clone` of master 553e318, `xvfb-run -a node e2e/run.js roster gemini`, one screenshot per effect E1–E14 (26/26 passed; log `logs/clean-roster-gemini.txt`)
- `gemini-effects-grid.png`: all of the above on one page
- `video/`: recordings of the full E1–E14 run per character (`gemini-e1-e14-clean-clone.webm` from the clean clone; the rest from the 4-character roster run)
- `roster-all/`: the 4-character roster run (105/105, `logs/roster-all.txt`), including `01-roster-dafeiyu-onboarding-offers-the-four-model-chan-no.png`
- `state-sheet.png`: every character × every state, drawn by the app (`e2e/run.js art`)
- `model-chan-preview.png`: art/model-chan/preview (DeepSeek video frames + 4 pixel packs)
- `c7-npmstart.png`: `npm start` in the fresh clone (following docs/model-chan.md, fake lh), first screen
- `logs/`: npm test 195/195, e2e all 186/186, clean-clone install and test
