# Notes for coding agents

- Verification reports (验证报告 / 验收) and the release gate follow the project acceptance layer in [`.agents/acceptance/PROJECT.md`](.agents/acceptance/PROJECT.md) (§7). The generic skill is committed at [`.agents/skills/acceptance`](.agents/skills/acceptance/SKILL.md) (refresh with `lh acceptance update`).
- Unit tests: `npm test`. App runs: `xvfb-run -a node e2e/run.js <scenario>` (avoid `all`: it includes the token-costing `live` scenario).
- Character art pipeline: [`art/model-chan/README.md`](art/model-chan/README.md).
