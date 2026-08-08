// Writes the public site to _site/. See scripts/site.js for what is published
// and why it is a curated directory rather than `docs/`.
//
// Run locally with `npm run build:site`; CI runs the same command, so what you
// see in _site/ is what deploys.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildPrivacyPage, buildIndexPage } = require('./site.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');

async function write(relPath, contents) {
  const target = join(out, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  return relPath;
}

// Rebuild from empty so a page deleted here cannot survive in the artefact.
await rm(out, { recursive: true, force: true });

const privacyMarkdown = await readFile(join(root, 'PRIVACY.md'), 'utf8');

const written = [
  await write('index.html', buildIndexPage()),
  await write('privacy/index.html', buildPrivacyPage(privacyMarkdown)),
  // Jekyll is not in play here, but Pages still runs it unless told otherwise,
  // and it would skip any file or directory beginning with an underscore.
  await write('.nojekyll', ''),
];

console.log(`Built site → _site/\n${written.map((f) => `  ${f}`).join('\n')}`);
