#!/usr/bin/env bash
# Renders icons/src/*.svg to the PNGs the manifest loads.
#
# The PNGs are committed rather than built on demand: the extension has to be
# loadable straight from a clone, and store packaging must not depend on a
# designer's toolchain being installed. Re-run this after editing any SVG.
#
# Inkscape is the renderer because it is what is on the dev machine. Two
# constraints it imposes, both learned the hard way:
#   - Paths must be absolute. Snap-confined Inkscape resolves relative paths
#     against $HOME, not the working directory, and silently fails.
#   - Those paths must be under $HOME. Snap confinement blocks /tmp entirely.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/icons/src"
out="$root/icons"

if ! command -v inkscape >/dev/null 2>&1; then
  echo "inkscape not found — install it, or render $src/*.svg by hand" >&2
  exit 1
fi

for size in 16 32 48 128; do
  svg="$src/icon-$size.svg"
  png="$out/icon$size.png"
  [ -f "$svg" ] || { echo "missing $svg" >&2; exit 1; }
  inkscape "$svg" -o "$png" -w "$size" -h "$size" >/dev/null 2>&1
  echo "  icon$size.png"
done

echo "Rendered 4 icons → icons/"
