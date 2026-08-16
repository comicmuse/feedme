// Names and commands for the store-submittable artefacts a release produces.
//
// Kept apart from release.mjs (the I/O that spawns zip, git and web-ext) so the
// naming rules — the part a version bump must not be able to break — are pure
// and unit-testable, the same split manifest.js draws against package.mjs.
const { TARGETS } = require('./manifest.js');

// Pinned so `npx web-ext` fetches the same linter every release; bumping it is a
// deliberate edit here, reviewed like any other, not whatever npm resolves on
// the day. Mirrors the AMO gate documented in AGENTS.md.
const WEB_EXT_VERSION = '8.3.0';

/**
 * Every artefact a release emits, in submission order: one loadable-then-zipped
 * package per store target, then the AMO source archive. The version is stamped
 * onto each so an artefact can never carry a stale label.
 * @param {string} version
 * @returns {string[]}
 */
function artefactNames(version) {
  return [
    ...TARGETS.map((target) => `feedme-${target}-${version}.zip`),
    `feedme-source-${version}.zip`,
  ];
}

/**
 * argv for `git archive` producing the source zip. HEAD, not the working tree,
 * so the archive is exactly the committed source — and because git archive only
 * ever contains tracked files, the gitignored node_modules/, build/, dist/ and
 * .playwright-mcp/ are excluded by construction (AMO's required exclusion set).
 * @param {string} outPath
 * @returns {string[]}
 */
function sourceArchiveArgs(outPath) {
  return ['archive', '--format=zip', '-o', outPath, 'HEAD'];
}

module.exports = { artefactNames, sourceArchiveArgs, WEB_EXT_VERSION };
