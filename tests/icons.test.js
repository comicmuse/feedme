const fs = require('fs');
const path = require('path');
const { buildManifest, TARGETS } = require('../scripts/manifest');

const ICONS = path.join(__dirname, '..', 'icons');

// PNG header: 8-byte signature, then the IHDR chunk whose width and height are
// big-endian uint32 at offsets 16 and 20. Enough to check dimensions without
// pulling in an image library for four files.
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error(`${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

describe('extension icons', () => {
  // Every size the manifest declares must exist at exactly that size. Chrome
  // and Firefox both scale a mismatched icon silently, so a wrong file here
  // shows up as a blurry toolbar rather than an error.
  test.each([16, 32, 48, 128])('icon%ipx exists at its declared size', (size) => {
    const { width, height } = pngSize(path.join(ICONS, `icon${size}.png`));
    expect({ width, height }).toEqual({ width: size, height: size });
  });

  // The original icons were 70-byte 1x1 transparent PNGs that shipped for
  // months unnoticed (#78). Size alone would catch a 1x1, but a blank file at
  // the right dimensions would pass — so require real content too.
  test.each([16, 32, 48, 128])('icon%ipx is real artwork, not a placeholder', (size) => {
    const { bytes } = pngSize(path.join(ICONS, `icon${size}.png`));
    expect(bytes).toBeGreaterThan(200);
  });

  // The manifest is generated, so this is what stops a new size being added to
  // one and not the other.
  test('every icon the manifest declares is present, and vice versa', () => {
    for (const target of TARGETS) {
      const declared = buildManifest(target).action.default_icon;
      expect(Object.keys(declared).map(Number).sort((a, b) => a - b)).toEqual([16, 32, 48, 128]);
      for (const [size, rel] of Object.entries(declared)) {
        expect(rel).toBe(`icons/icon${size}.png`);
        expect(fs.existsSync(path.join(__dirname, '..', rel))).toBe(true);
      }
    }
  });

  // The SVGs are the editable source; the PNGs are build output committed for
  // packaging. Losing the source would make the next tweak a redraw.
  test.each([16, 32, 48, 128])('icon%ipx keeps its SVG source', (size) => {
    expect(fs.existsSync(path.join(ICONS, 'src', `icon-${size}.svg`))).toBe(true);
  });
});
