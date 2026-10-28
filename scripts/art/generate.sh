#!/bin/bash
# Regenerate 大肥鱼's illustrated outfit pictures (see NOTICE.md). Needs a logged-in `lh`, python3 with Pillow + numpy.
#   scripts/art/generate.sh <work-dir> [name ...]     e.g. scripts/art/generate.sh /tmp/art dafeiyu_yukata
# Each picture: `lh generate image` -> <work-dir>/raw/<species>_<outfit>.png -> cut out (cutout.py)
# -> src/renderer/packs/<species>-illustrated/<outfit>.webp (listed in that pack.json). "logo" becomes build/icon.png by hand.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${1:?work dir}"; shift || true
MODEL="${PIXELPET_ART_MODEL:-gpt-image-2.5-sunburst}"
mkdir -p "$WORK/raw" "$WORK/cut"
python3 -I "$HERE/prompts.py" > "$WORK/jobs.json"
python3 -I -c 'import json,sys; [print(j["name"]+"\t"+j["prompt"]) for j in json.load(open(sys.argv[1]))]' "$WORK/jobs.json" | while IFS=$'\t' read -r name prompt; do
  if [ $# -gt 0 ] && [[ ! " $* " =~ " $name " ]]; then continue; fi
  out="$WORK/raw/$name.png"
  if [ ! -s "$out" ]; then
    j=$(lh generate image -m "$MODEL" -p lobehub "$prompt" --json)
    g=$(printf '%s' "$j" | grep -o '"id": "gen_[^"]*' | head -1 | cut -d'"' -f4)
    a=$(printf '%s' "$j" | grep -o '"asyncTaskId": "[^"]*' | head -1 | cut -d'"' -f4)
    lh generate download "$g" "$a" -o "$out" --interval 4 --timeout 400 >/dev/null
  fi
  [ "$name" = logo ] && continue
  species="${name%%_*}"; outfit="${name#*_}"
  [ "$species" = dafeiyu ] && [ "$outfit" = daily ] && continue # Dafeiyu's signature outfit is its animation
  python3 -I "$HERE/cutout.py" "$out" "$WORK/cut/$name.png" 480 >/dev/null
  mkdir -p "$ROOT/src/renderer/packs/$species-illustrated"
  python3 -I -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).save(sys.argv[2], "WEBP", quality=88, method=6)' "$WORK/cut/$name.png" "$ROOT/src/renderer/packs/$species-illustrated/$outfit.webp"
  echo "ok $name"
done
