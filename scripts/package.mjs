// Assemble a clean, loadable extension directory in build/.
//
// Loading the extension straight from the repo root makes Chrome hash the whole
// tree on every load — node_modules, .git, .playwright-mcp (thousands of files,
// ~40s). The browser only needs the manifest plus dist/, popup/, and icons/, so
// copy just those into build/ and point "Load unpacked" there for instant loads.
import { rm, mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The manifest's paths (dist/…, popup/popup.html, icons/…) are preserved, so the
// layout under build/ mirrors the repo — only the surrounding junk is dropped.
for (const entry of ['manifest.json', 'dist', 'popup', 'icons']) {
  await cp(join(root, entry), join(out, entry), { recursive: true });
}

console.log('Packaged extension → build/ (load this directory as unpacked)');
