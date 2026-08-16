# Release checklist

How to cut a store release of FeedMe. The artefact build is scripted
(`npm run release`); this list covers the human steps around it so they are not
rediscovered each time.

## 1. Prepare

- [ ] Working tree clean and on the commit you intend to ship (`git status`).
- [ ] Node matches the pin: `nvm use` (reads `.nvmrc`, currently 24.13.1).
- [ ] Bump `version` in `package.json` (the manifest and every artefact name
      derive from it — nothing else to edit). Commit the bump.
- [ ] `npm ci && npm test` — all green.

## 2. Build the artefacts

- [ ] `npm run release`

  This rebuilds from source and emits into `build/`:
  - `feedme-chrome-<version>.zip` — upload to the Chrome Web Store.
  - `feedme-firefox-<version>.zip` — upload to AMO as the add-on.
  - `feedme-source-<version>.zip` — upload to AMO as the source archive.

  The script fails if `web-ext lint --warnings-as-errors` finds anything, so a
  Firefox-manifest regression cannot ship. If it fails, fix and re-run — do not
  submit a partial `build/`.

## 3. Submit

- [ ] **AMO** (addons.mozilla.org): upload `feedme-firefox-<version>.zip`, then
      the source archive `feedme-source-<version>.zip`. `docs/store/AMO_REVIEW.md`
      (inside the source archive) covers the reviewer's build instructions.
- [ ] **Chrome Web Store**: upload `feedme-chrome-<version>.zip`. Re-confirm the
      permission justifications if the permission set changed
      (`tests/manifest.test.js` asserts the exact set).
- [ ] Store listing copy lives in `docs/store/listing-copy.md` — update if the
      feature set changed.

## 4. Record

- [ ] Tag the release commit: `git tag v<version> && git push --tags`.
- [ ] Note anything reviewers queried for next time.
