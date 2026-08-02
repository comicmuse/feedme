// Assemble clean, loadable extension directories in build/<target>/.
//
// Loading the extension straight from the repo root makes Chrome hash the whole
// tree on every load — node_modules, .git, .playwright-mcp (thousands of files,
// ~40s). The browser only needs the manifest plus dist/, popup/, and icons/, so
// copy just those and point "Load unpacked" at build/chrome/ for instant loads.
//
// One directory per target because Chrome and Firefox need different background
// keys — see scripts/manifest.js for why they cannot share a manifest.
import { rm, mkdir, cp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildManifest, TARGETS } = require('./manifest.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');

await rm(out, { recursive: true, force: true });

for (const target of TARGETS) {
  const dir = join(out, target);
  await mkdir(dir, { recursive: true });
  // The generated manifest's paths (dist/…, popup/popup.html, icons/…) mirror the
  // repo layout, so the copied tree needs no rewriting — only the surrounding junk
  // is dropped.
  for (const entry of ['dist', 'popup', 'icons']) {
    await cp(join(root, entry), join(dir, entry), { recursive: true });
  }
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(buildManifest(target), null, 2)}\n`);
}

console.log(`Packaged → ${TARGETS.map((t) => `build/${t}/`).join('  ')}`);
console.log('Load build/chrome/ as unpacked in Chrome; build/firefox/ via about:debugging in Firefox.');
