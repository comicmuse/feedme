// Build the store-submittable artefacts for a release, always from a fresh build.
//
// `npm run package` leaves loadable build/<target>/ dirs; stores want archives.
// This script rebuilds from source (never zips whatever snapshot is on disk —
// the staleness trap AGENTS.md warns about), then emits:
//
//   build/feedme-<target>-<version>.zip   one submittable package per store
//   build/feedme-source-<version>.zip     the AMO source archive (git archive HEAD)
//
// and gates the result through `web-ext lint`, so a Firefox-manifest regression
// cannot ship. Run it via `npm run release`. See docs/RELEASE.md for the wider
// checklist (version bump, changelog, dashboard steps) this script does not own.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { TARGETS } = require('./manifest.js');
const { sourceArchiveArgs, WEB_EXT_VERSION } = require('./artefacts.js');
const { version } = require('../package.json');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');

// Inherit stdio so esbuild/web-ext output streams straight to the release log,
// and reject on any non-zero exit so a failed step aborts the release rather
// than leaving a half-built set of artefacts behind.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
  });
}

// 1. Fresh build — the same two steps as `npm run package`, run from source so
//    the artefacts can never lag the code.
await run('node', ['esbuild.config.mjs']);
await run('node', ['scripts/package.mjs']);

// 2. One submittable zip per store target, from inside build/<target>/ so the
//    archive's paths are manifest-root-relative (manifest.json at the top, no
//    build/chrome/ prefix). -X drops platform extra-field cruft for a clean,
//    reproducible-ish archive; -r recurses.
for (const target of TARGETS) {
  const zip = join(build, `feedme-${target}-${version}.zip`);
  await run('zip', ['-r', '-X', zip, '.'], { cwd: join(build, target) });
}

// 3. AMO source archive from the committed tree. git archive contains only
//    tracked files, so node_modules/build/dist/.playwright-mcp are excluded for
//    free; the reviewer README (docs/store/AMO_REVIEW.md) is tracked, so it
//    rides along automatically.
await run('git', sourceArchiveArgs(join(build, `feedme-source-${version}.zip`)));

// 4. The AMO gate. --warnings-as-errors so a new warning fails the release the
//    same way an error would; this is the check Mozilla runs on submission.
await run('npx', [
  '--yes',
  `web-ext@${WEB_EXT_VERSION}`,
  'lint',
  '--source-dir',
  join(build, 'firefox'),
  '--warnings-as-errors',
]);

const artefacts = [
  ...TARGETS.map((t) => `feedme-${t}-${version}.zip`),
  `feedme-source-${version}.zip`,
];
console.log(`\nRelease artefacts (v${version}) → ${artefacts.map((a) => `build/${a}`).join('  ')}`);
