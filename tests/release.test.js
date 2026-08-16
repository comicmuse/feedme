const { artefactNames, sourceArchiveArgs, WEB_EXT_VERSION } = require('../scripts/artefacts');
const { TARGETS } = require('../scripts/manifest');
const pkg = require('../package.json');

describe('artefactNames', () => {
  test('emits one submittable zip per store target plus a source archive', () => {
    const names = artefactNames(pkg.version);
    expect(names).toEqual([
      ...TARGETS.map((t) => `feedme-${t}-${pkg.version}.zip`),
      `feedme-source-${pkg.version}.zip`,
    ]);
  });

  // The version is threaded through every name so a release bump cannot leave an
  // artefact labelled with the previous version — the same guarantee manifest.js
  // gives the manifest.
  test('stamps the given version onto every artefact', () => {
    const names = artefactNames('9.9.9');
    expect(names.every((n) => n.includes('9.9.9'))).toBe(true);
    expect(names).toHaveLength(TARGETS.length + 1);
  });
});

describe('sourceArchiveArgs', () => {
  // git archive of HEAD is the whole point: it contains only tracked files, so
  // node_modules/, build/, dist/ and .playwright-mcp/ — all gitignored — are
  // excluded by construction, which is exactly AMO's required exclusion set.
  test('builds a git archive of HEAD to the given output path', () => {
    expect(sourceArchiveArgs('/tmp/out.zip')).toEqual([
      'archive',
      '--format=zip',
      '-o',
      '/tmp/out.zip',
      'HEAD',
    ]);
  });
});

describe('WEB_EXT_VERSION', () => {
  test('is pinned so the lint gate cannot drift between releases', () => {
    expect(WEB_EXT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
