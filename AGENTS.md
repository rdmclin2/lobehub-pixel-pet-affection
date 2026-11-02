# Notes for coding agents

- Verification reports (验证报告 / 验收) and the release gate follow the project acceptance layer in [`.agents/acceptance/PROJECT.md`](.agents/acceptance/PROJECT.md) (§7). The generic skill is committed at [`.agents/skills/acceptance`](.agents/skills/acceptance/SKILL.md) (refresh with `lh acceptance update`).
- Unit tests: `npm test`. App runs: `xvfb-run -a node e2e/run.js <scenario>` (avoid `all`: it includes the token-costing `live` scenario).
- Character art pipeline: [`art/model-chan/README.md`](art/model-chan/README.md).

<!-- lobe-design:begin · managed by scripts/bootstrap.mjs · 不要手动编辑本块 -->
<!-- lobe-design:mode=compact lang=en -->
## UI design guide (lobe-design · compact)

UI work (new pages, interaction, visuals, design-system cleanup, screenshot restore, pre-launch review) goes through **lobe-design**: `https://github.com/lobehub/lobe-design-skill` (skill version 5.9.0).

```bash
export LOBE_DESIGN="./.agents/skills/lobe-design"   # global install: ${HOME}/.claude/skills/lobe-design
```

- **Entry**: read `$LOBE_DESIGN/SKILL.md`; run `node "$LOBE_DESIGN/scripts/route.mjs" "<request verbatim>"` first, then enter one stage at a time and load only what it lists.
- **Read the project layer first**: `.agents/ux/product.md` (platform and applicability), `.agents/ux/components.md` (which component to use); run 05-init to create any missing one.
- **Platform: web**: atoms come from `@lobehub/ui`; values come from `cssVar` tokens.
- **Precedence**: platform and applicability in `product.md` (rules marked not applicable, platform-scoped rules) override the skill's generic rules; other conflicts follow the skill. A project rule that contradicts a universal principle (accessibility, P-xx archetypes) must state its reason.
- **After code changes**: run `node "$LOBE_DESIGN/scripts/lint-lobe.mjs" <changed paths>` (rule set follows the platform in product.md); every FAIL must be fixed.
- **Record corrections**: in `.agents/ux/lobe-design-rules.md`; criteria, layering and upstreaming are in `$LOBE_DESIGN/learnings/README.md` and `$LOBE_DESIGN/CONTRIBUTING.md`.
- **After install or upgrade**: run 05-init (two rounds); `node "$LOBE_DESIGN/scripts/project-scan.mjs" --check` reports a missing or stale project layer.

> Managed by `$LOBE_DESIGN/scripts/bootstrap.mjs`; rerun to update. Pass `--full` for the detailed (Chinese) version with self-iteration and upstreaming rules.
<!-- lobe-design:end -->
