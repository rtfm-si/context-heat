#!/bin/sh
# Rasterise media/icon.svg -> media/icon.png (128x128, what the Marketplace wants).
#
# ImageMagick's built-in SVG renderer ignores linearGradient and fills the flame
# flat black, so we render through macOS QuickLook, which honours it, then trim
# QuickLook's padding and square it up.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

qlmanage -t -s 512 -o "$tmp" icon.svg >/dev/null 2>&1
[ -f "$tmp/icon.svg.png" ] || { echo "qlmanage failed to render icon.svg" >&2; exit 1; }

magick "$tmp/icon.svg.png" -trim +repage \
  -resize 128x128 -background none -gravity center -extent 128x128 \
  icon.png
echo "wrote $(pwd)/icon.png"
