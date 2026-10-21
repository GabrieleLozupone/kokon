"""Voice-over of the vertical reels (voiceover-reels.md), with the 0.10 video's voice and master.

    D:/AI/tts/.venv/Scripts/python gen_reel_voice.py [--seed 11] [--lines 3,7]

One take per sentence (seed + 10 * sentence), 0.4 s between sentences, mastered and set to -16 LUFS
over all lines like gen_voice.py's build. Writes voice/reels-<stamp>/NN.wav and copies them to
video/public/voice-reels with their sentence spans in video/src/app/voice-reels.json. `--lines`
redoes only those lines (with another --seed) and keeps the others.
"""
import argparse
import json
import shutil
import time

import numpy as np
import soundfile as sf

from gen_voice import LUFS, OUT, SENTENCE_PAUSE, SR, VIDEO, lufs, master, say, script_lines, sentences

SCRIPT = "voiceover-reels.md"
# Settings per line: the openers and the lists read "expressive", the rest "calmer".
TAKE = {n: "expressive" for n in (1, 2, 5, 7, 9, 10, 15, 16, 17, 18)}


def main(seed: int, only: set[int] | None) -> None:
    lines = script_lines(SCRIPT)
    folder = OUT / f"reels-{time.strftime('%Y%m%d-%H%M%S')}"
    (folder / "raw").mkdir(parents=True)
    dst = VIDEO / "public" / "voice-reels"
    spans_path = VIDEO / "src" / "app" / "voice-reels.json"
    spans = json.loads(spans_path.read_text(encoding="utf-8")) if only and spans_path.exists() else {}
    files = []
    for n, line in enumerate(lines, 1):
        if only and n not in only:
            continue
        chunks, marks, pos = [], [], 0
        parts = sentences(line)
        for i, text in enumerate(parts):
            c = say(TAKE.get(n, "calmer"), text, None, seed + 10 * i)
            chunks.append(c)
            marks.append([round(pos / SR, 3), round((pos + c.size) / SR, 3)])
            pos += c.size
            if i < len(parts) - 1:
                chunks.append(np.zeros(int(SENTENCE_PAUSE * SR), dtype=np.float32))
                pos += chunks[-1].size
        spans[str(n)] = {"dur": round(pos / SR, 3), "sentences": marks}
        raw = folder / "raw" / f"{n:02d}.wav"
        sf.write(raw, np.concatenate(chunks), SR)
        master(raw, folder / f"{n:02d}.wav")
        files.append(folder / f"{n:02d}.wav")
        print(f"{n:02d}  {pos / SR:4.1f} s  {line}", flush=True)
    gap = np.zeros(int(0.9 * 48000), dtype=np.float32)
    preview = np.concatenate([x for f in files for x in (sf.read(f, dtype="float32")[0], gap)])
    sf.write(folder / "all.wav", preview, 48000)
    gain = LUFS - lufs(folder / "all.wav")
    for f in [*files, folder / "all.wav"]:
        tmp = f.with_suffix(".tmp.wav")
        master(f, tmp, gain)
        tmp.replace(f)
    dst.mkdir(parents=True, exist_ok=True)
    for f in files:
        shutil.copy(f, dst / f.name)
    spans_path.write_text(json.dumps(dict(sorted(spans.items(), key=lambda kv: int(kv[0]))), indent=1) + "\n", encoding="utf-8")
    print(f"{folder}: copied to video/public/voice-reels, spans in video/src/app/voice-reels.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--lines", help="comma-separated line numbers to redo")
    a = ap.parse_args()
    main(a.seed, {int(x) for x in a.lines.split(",")} if a.lines else None)
