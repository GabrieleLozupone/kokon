#!/bin/bash
# The fixed test set of a Mac engine pull request (engine-mac/AGENTS.md): the same prompts, sizes and seeds for
# everyone, run alternated through tools/ab.sh, so results from different branches and Macs can be compared.
#
#   bash tools/ab.sh snapshot base   # on master;  then on the branch:  swift build -c release;  bash tools/ab.sh snapshot new
#   bash tools/testset.sh 3 "base|base|" "new|new|"
#
# The cases: text to image at 1024², a wide image (1344×768: not tuned so far), an edit with a reference image (made
# once by the first arm and kept in $AB_DIR/testset). A brushed edit (mask) is not in the command line: try one in the
# app with the branch's engine and say so in the report. Model files: Kokon's (KOKON_MODELS to point elsewhere).
# Minutes per run and per arm: plugged in, other apps closed, no build while it runs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="${AB_DIR:-$HOME/kokon-bench/ab}"
models="${KOKON_MODELS:-$HOME/Library/Application Support/KokonData/sdcpp/models/qwen21}"
[ $# -ge 2 ] || { sed -n 2,11p "$0"; exit 1; }
rounds="$1"; shift
arms=("$@")

first() { for f in "$@"; do [ -f "$models/$f" ] && { echo "$models/$f"; return; }; done; echo "$models/$1"; }
enc="$(first Qwen3VL-8B-Instruct-Q4_K_M.gguf)"
dit="$(first qwen-image-2.1-turbo-Q4_K_M.gguf qwen-image-2.1-turbo-Q4_K.gguf)"
vae="$(first texture_fix_vae_for_qwen_image_2.1_bf16.safetensors qwen_image_2.1_vae_bf16.safetensors)"
mmproj="$(first mmproj-Qwen3VL-8B-Instruct-F16.gguf)"
for f in "$enc" "$dit" "$vae" "$mmproj"; do
    [ -f "$f" ] || { echo "$f not found: set up Kokon's models once, or set KOKON_MODELS"; exit 1; }
done

work="$dir/testset"
mkdir -p "$work"
ref="$work/reference.png"
if [ ! -f "$ref" ]; then
    IFS='|' read -r _ snapshot _ <<< "${arms[0]}"
    echo "== the edit's reference image (once, with $snapshot)"
    "$dir/$snapshot/kokon-engine-mac" generate "$enc" "$dit" "$vae" \
        "A cozy wooden cabin by a lake in autumn, a red canoe on the shore, afternoon light, photo" \
        --size 1024x768 --seed 7 --out "$ref" > /dev/null
fi

echo "== 1. text to image, 1024x1024"
bash "$here/ab.sh" run "$rounds" "${arms[@]}" -- generate "$enc" "$dit" "$vae" \
    "A red fox in fresh snow at dawn, a wooden sign that says KOKON, soft golden light, photo" \
    --size 1024x1024 --seed 42 --out "$work/t2i.png"
echo "== 2. wide image, 1344x768"
bash "$here/ab.sh" run "$rounds" "${arms[@]}" -- generate "$enc" "$dit" "$vae" \
    "A narrow street at night after the rain, a yellow tram, a neon sign that says CAFE, reflections, photo" \
    --size 1344x768 --seed 42 --out "$work/wide.png"
echo "== 3. edit with a reference"
bash "$here/ab.sh" run "$rounds" "${arms[@]}" -- generate "$enc" "$dit" "$vae" \
    "Make it a winter evening with falling snow, keep the cabin, the lake and the canoe" \
    --ref "$ref" --mmproj "$mmproj" --seed 42 --out "$work/edit.png"
echo "Images of the last arm in $work. A brushed edit: try one in the app and note it in the report."
