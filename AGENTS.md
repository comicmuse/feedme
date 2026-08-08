# Agent instructions

Browser extension comparing a takeaway order across Uber Eats / Deliveroo / Just Eat. See README.md for architecture.

## Commands

- `npm test` — Jest; `npm run build` — esbuild to `dist/` (what the manifest loads; rebuild after every src change).
- `npm run package` — builds, then assembles one loadable extension per target in `build/chrome/` and `build/firefox/` (generated manifest + `dist/`, `popup/`, `icons/` only). **Load `build/chrome/` as the unpacked extension in Chrome, never the repo root** — loading the root makes Chrome hash the whole tree (node_modules, .git, .playwright-mcp: thousands of files, ~40s per load). Firefox loads `build/firefox/` via `about:debugging`. `build/` is gitignored and is a manual snapshot — `npm run build`/`npm test` only refresh `dist/`, not `build/`. **Always run `npm run package` right before asking for live verification**, or the user will be testing stale code with no diff or error to reveal it.
- **Never hand-edit a manifest.** `manifest.json` is generated per target by `scripts/manifest.js` from `manifest.base.json` + `package.json`'s version. Chrome and Firefox need different `background` keys (Firefox has no `service_worker`), so edit the base or the per-target overrides, and cover the change in `tests/manifest.test.js`. `npx web-ext lint --source-dir build/firefox` is what AMO runs — keep it at zero warnings.
- `src/shared/` is plain CommonJS: it runs in Jest, Node scripts, and the bundles alike.

## Rules

- **TDD**: failing test first, watch it fail, then implement. Bug fixes start with a test reproducing the bug.
- **Deterministic over heuristic**: prices, fees, ids, and offer eligibility come from platform data, never fuzzy guesses; label anything estimated. When in doubt, prefer an honest "add manually"/"approx." over false completeness.
- **Verify live**: platform DOM and data shapes drift — don't trust comments or memory, re-probe the real site. Recipe: `.claude/skills/verify/SKILL.md`. Pin newly observed shapes as test fixtures.
- The `[FeedMe …]` console logging is deliberate (the builder acts on real baskets with no other visibility) — keep it.
- The basket builder must never throw and must not count an item as added unless the platform's own dialog confirmed it.

## Workflow

- Branch per change; PRs merge to `main` with merge commits. Don't commit to `main` directly (docs excepted).
- One shippable unit per GitHub issue. If a PR ships only a slice, file the remainder as a new issue and close the original with the PR.
