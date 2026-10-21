"""Voiceover takes for the launch video, generated locally with Chatterbox (MIT, Resemble AI).

    D:/AI/tts/.venv/Scripts/python gen_voice.py [take ...]          -> voice/<take>.wav
    D:/AI/tts/.venv/Scripts/python gen_voice.py --ref me.wav [take ...]
    D:/AI/tts/.venv/Scripts/python gen_voice.py final              -> voice/final/NN.wav (approved take)
    D:/AI/tts/.venv/Scripts/python gen_voice.py redo 3 --keep 0:0,4:2 [--seeds 6]
                                                    -> voice/redo-<stamp>/: takes of line 3's new sentences
    D:/AI/tts/.venv/Scripts/python gen_voice.py splice 3 --keep 0:0,4:2 --pick 1:13,2:22 --from voice/redo-<stamp>
                                                    -> line 3 rebuilt from kept and picked sentences

The "Kokon 0.10" update video has its own script (voiceover-0.10.md) and its own files, so the
launch take is never touched:

    D:/AI/tts/.venv/Scripts/python gen_voice.py audition [--seeds 4]
                                                    -> voice/update-0.10/audition-<stamp>/: takes of every sentence
    D:/AI/tts/.venv/Scripts/python gen_voice.py build --from voice/update-0.10/audition-<stamp> --pick 1.0:11,2.0:23,...
                                                    -> voice/update-0.10/final-<stamp>/NN.wav, copied to
                                                       video/public/voice-0.10 with video/src/app/voice-0.10.json

redo/splice change single sentences of the approved take: `--keep NEW:OLD` reuses old sentence
OLD (cut from voice/final/raw by raw/spans.json) as new sentence NEW; the other sentences of the
line in voiceover.md get takes to audition, and `--pick NEW:SEED` chooses one each (the auditioned file itself). splice backs
voice/final up first and matches the line's loudness to the old file.

Each take reads the whole script (voiceover.md, one file per line too, in voice/<take>/NN.wav)
so takes can be compared on the same text. Without --ref the model's built-in voice is used;
--ref clones the timbre of a clean recording of at least 5-10 s (only use a voice you have the
right to use, e.g. your own).
"""
import argparse
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as F

HERE = Path(__file__).parent
OUT = HERE / "voice"
VIDEO = HERE.parent / "video"
SR = 24000
PAUSE = 0.9

# name: (model, exaggeration, cfg_weight, temperature)
TAKES = {
    "calm": ("base", 0.35, 0.5, 0.7),
    "warm": ("base", 0.5, 0.4, 0.8),
    "expressive": ("base", 0.7, 0.3, 0.8),
    "turbo": ("turbo", 0.0, 0.0, 0.8),
    "calmer": ("base", 0.55, 0.2, 0.8),
}

# The approved take (`gen_voice.py final`), picked by ear line by line. Each line is read one
# sentence at a time (seed + i for sentence i) with a pause in between, which slows the
# delivery down. Per line: (take, seed[, {sentence index: (take, seed)}[, pauses]]).
FINAL = {
    1: ("calmer", 61),
    2: ("calmer", 11),
    3: ("expressive", 11),
    4: ("expressive", 11),
    5: ("calmer", 11),
    6: ("expressive", 31),
    7: ("expressive", 21),
    8: ("calmer", 11),
    9: ("expressive", 31, {2: ("calmer", 71)}, [0.4, 0.55, 0.55]),
}
SENTENCE_PAUSE = 0.4
# Light voice-over master: rumble cut, de-ess, gentle compression. Loudness is set afterwards
# with one gain for all lines, so their relative levels stay as read.
MASTER = "aresample=48000,highpass=f=80,deesser=i=0.4,acompressor=threshold=-20dB:ratio=3:attack=5:release=90"
LUFS = -16.0


def script_lines(script: str = "voiceover.md") -> list[str]:
    rows = [l for l in (HERE / script).read_text(encoding="utf-8").splitlines() if re.match(r"^\| \d+ \|", l)]
    return [r.split("|")[4].strip() for r in rows]


_models: dict = {}


def model(kind: str):
    if kind not in _models:
        if kind == "turbo":
            from chatterbox.tts_turbo import ChatterboxTurboTTS as M
        else:
            from chatterbox.tts import ChatterboxTTS as M
        _models[kind] = M.from_pretrained(device="cuda")
    return _models[kind]


def say(take: str, text: str, ref: Path | None, seed: int) -> np.ndarray:
    kind, exag, cfg, temp = TAKES[take]
    m = model(kind)
    torch.manual_seed(seed)
    kw = dict(audio_prompt_path=str(ref) if ref else None, temperature=temp)
    if kind == "base":
        kw.update(exaggeration=exag, cfg_weight=cfg)
    with torch.inference_mode():
        wav = m.generate(text, **kw)
    return F.resample(wav, m.sr, SR).squeeze(0).cpu().numpy()


def read(take: str, ref: Path | None, seed: int) -> None:
    lines = script_lines()
    gap = np.zeros(int(PAUSE * SR), dtype=np.float32)
    folder = OUT / take
    folder.mkdir(parents=True, exist_ok=True)
    parts = []
    for i, line in enumerate(lines, 1):
        a = say(take, line, ref, seed + i)
        sf.write(folder / f"{i:02d}.wav", a, SR)
        parts += [a, gap]
    audio = np.concatenate(parts).astype(np.float32)
    audio /= max(1e-6, np.abs(audio).max()) / 0.89
    sf.write(OUT / f"{take}.wav", audio, SR)
    print(f"{take}.wav  {audio.size / SR:.1f} s", flush=True)


def sentences(line: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.?!])\s+", line) if s]


def master(src: Path, dst: Path, gain_db: float = 0.0) -> None:
    # alimiter at -1.5 dBFS: the loudness gain would otherwise clip the peaks.
    af = MASTER if gain_db == 0 else f"volume={gain_db:.2f}dB,alimiter=limit=0.84:attack=5:release=50:level=0"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", af, str(dst)], check=True)


def lufs(path: Path) -> float:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)[-1])


def final() -> None:
    """voice/final/NN.wav, one mastered file per line at -16 LUFS, plus final.wav to preview them in a row.

    Also copies the lines to the video (public/voice/NN.wav) with src/app/voice.json: each line's
    length and where each sentence starts and ends in it, so scenes can place single sentences.
    """
    folder = OUT / "final"
    (folder / "raw").mkdir(parents=True, exist_ok=True)
    spans: dict[int, dict] = {}
    for n, line in enumerate(script_lines(), 1):
        spec = FINAL[n]
        take, seed = spec[:2]
        swap = spec[2] if len(spec) > 2 else {}
        pauses = spec[3] if len(spec) > 3 else None
        parts = sentences(line)
        pauses = pauses or [SENTENCE_PAUSE] * (len(parts) - 1)
        chunks, marks, pos = [], [], 0
        for i, s in enumerate(parts):
            t, sd = swap.get(i, (take, seed + i))
            chunks.append(say(t, s, None, sd))
            marks.append([round(pos / SR, 3), round((pos + chunks[-1].size) / SR, 3)])
            pos += chunks[-1].size
            if i < len(pauses):
                chunks.append(np.zeros(int(pauses[i] * SR), dtype=np.float32))
                pos += chunks[-1].size
        spans[n] = {"dur": round(pos / SR, 3), "sentences": marks}
        raw = folder / "raw" / f"{n:02d}.wav"
        sf.write(raw, np.concatenate(chunks), SR)
        master(raw, folder / f"{n:02d}.wav")
        print(f"{n:02d}  {sum(c.size for c in chunks) / SR:4.1f} s  {line}", flush=True)
    files = [folder / f"{n:02d}.wav" for n in FINAL]
    gap = np.zeros(int(PAUSE * 48000), dtype=np.float32)
    preview = np.concatenate([x for f in files for x in (sf.read(f, dtype="float32")[0], gap)])
    sf.write(folder / "final.wav", preview, 48000)
    gain = LUFS - lufs(folder / "final.wav")
    for f in [*files, folder / "final.wav"]:
        tmp = f.with_suffix(".tmp.wav")
        master(f, tmp, gain)
        tmp.replace(f)
    print(f"final.wav  {preview.size / 48000:.1f} s, gain {gain:+.1f} dB -> {lufs(folder / 'final.wav'):.1f} LUFS")
    (VIDEO / "public" / "voice").mkdir(parents=True, exist_ok=True)
    for f in files:
        shutil.copy(f, VIDEO / "public" / "voice" / f.name)
    (VIDEO / "src" / "app" / "voice.json").write_text(json.dumps(spans, indent=1) + "\n", encoding="utf-8")
    print("copied to video/public/voice, timings in video/src/app/voice.json")


def pairs(arg: str | None) -> dict[int, int]:
    return {int(a): int(b) for a, b in (p.split(":") for p in arg.split(","))} if arg else {}


def redo(n: int, keep: dict[int, int], seeds: int, take: str, base: int) -> None:
    """Takes of the sentences of line `n` that are not kept, for picking by ear."""
    parts = sentences(script_lines()[n - 1])
    folder = OUT / f"redo-{time.strftime('%Y%m%d-%H%M%S')}"
    folder.mkdir(parents=True)
    for i, text in enumerate(parts):
        if i in keep:
            continue
        for k in range(seeds):
            seed = base + 10 * i + k
            a = say(take, text, None, seed)
            raw = folder / f"{n:02d}-s{i}-seed{seed}.raw.wav"
            sf.write(raw, a, SR)
            master(raw, folder / f"{n:02d}-s{i}-seed{seed}.wav")
            print(f"{n:02d} s{i} seed {seed}  {a.size / SR:4.1f} s  {text}", flush=True)
    print(f"takes ({take}) in {folder}")


def splice(n: int, keep: dict[int, int], pick: dict[int, int], src: Path) -> None:
    """Line `n` rebuilt: kept sentences cut from the approved raw file, picked takes from `src`
    (the raw files redo wrote), 0.4 s between sentences, mastered to the old file's loudness."""
    parts = sentences(script_lines()[n - 1])
    missing = [i for i in range(len(parts)) if i not in keep and i not in pick]
    if missing:
        raise SystemExit(f"no take picked for sentences {missing}")
    folder = OUT / "final"
    spans_file = folder / "raw" / "spans.json"
    spans = json.loads(spans_file.read_text(encoding="utf-8"))
    old_raw, sr = sf.read(folder / "raw" / f"{n:02d}.wav", dtype="float32")
    assert sr == SR
    backup = OUT / f"final-backup-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copytree(folder, backup)
    target = lufs(folder / f"{n:02d}.wav")
    chunks, marks, pos = [], [], 0
    for i, text in enumerate(parts):
        if i in keep:
            a, b = spans[str(n)]["sentences"][keep[i]]
            c = old_raw[int(round(a * SR)):int(round(b * SR))]
        else:
            c, sr = sf.read(src / f"{n:02d}-s{i}-seed{pick[i]}.raw.wav", dtype="float32")
            assert sr == SR
        chunks.append(c)
        marks.append([round(pos / SR, 3), round((pos + c.size) / SR, 3)])
        pos += c.size
        if i < len(parts) - 1:
            chunks.append(np.zeros(int(SENTENCE_PAUSE * SR), dtype=np.float32))
            pos += chunks[-1].size
    raw = folder / "raw" / f"{n:02d}.wav"
    sf.write(raw, np.concatenate(chunks), SR)
    spans[str(n)] = {"dur": round(pos / SR, 3), "sentences": marks}
    spans_file.write_text(json.dumps(spans, indent=1) + "\n", encoding="utf-8")
    tmp = folder / f"{n:02d}.tmp.wav"
    master(raw, tmp)
    master(tmp, folder / f"{n:02d}.wav", target - lufs(tmp))
    tmp.unlink()
    shutil.copy(folder / f"{n:02d}.wav", VIDEO / "public" / "voice" / f"{n:02d}.wav")
    vj = VIDEO / "src" / "app" / "voice.json"
    video = json.loads(vj.read_text(encoding="utf-8"))
    video[str(n)] = spans[str(n)]
    vj.write_text(json.dumps(video, indent=1) + "\n", encoding="utf-8")
    print(f"{n:02d}  {pos / SR:4.1f} s at {lufs(folder / f'{n:02d}.wav'):.1f} LUFS (was {target:.1f}); backup in {backup}")


# The "Kokon 0.10" update video (voiceover-0.10.md): each line's model settings, as in FINAL.
UPDATE = {"script": "voiceover-0.10.md", "dir": OUT / "update-0.10", "public": "voice-0.10", "json": "voice-0.10.json"}
UPDATE_TAKES = {1: "calmer", 2: "expressive", 3: "expressive", 4: "expressive", 5: "calmer", 6: "expressive"}
# build: seconds between a line's sentences where not 0.4 (line 3, Prompt+'s model, read slower),
# and silences put inside a sentence ("LINE.SENTENCE": [(seconds into the take, seconds)]): the
# micro-pause in "One model, two jobs." falls in the take's own silence before "two".
UPDATE_PAUSES = {3: 0.7}
UPDATE_SPLITS = {"3.0": [(0.93, 0.35)]}


def audition(seeds: int, base: int) -> None:
    """`seeds` takes of every sentence of the update script, read one at a time, for picking by ear."""
    folder = UPDATE["dir"] / f"audition-{time.strftime('%Y%m%d-%H%M%S')}"
    folder.mkdir(parents=True)
    for n, line in enumerate(script_lines(UPDATE["script"]), 1):
        take = UPDATE_TAKES.get(n, "expressive")
        for i, text in enumerate(sentences(line)):
            for k in range(seeds):
                seed = base + 10 * i + k
                a = say(take, text, None, seed)
                raw = folder / f"{n:02d}-s{i}-seed{seed}.raw.wav"
                sf.write(raw, a, SR)
                master(raw, folder / f"{n:02d}-s{i}-seed{seed}.wav")
                print(f"{n:02d} s{i} seed {seed}  {a.size / SR:4.1f} s  {text}", flush=True)
    print(f"takes in {folder}")


def build(src: Path, pick: dict[str, int]) -> None:
    """The update's lines from the picked sentence takes (`pick` "LINE.SENTENCE" -> seed), 0.4 s
    between sentences (UPDATE_PAUSES, UPDATE_SPLITS), mastered like the launch take (-16 LUFS over all lines). Each build goes to
    a new folder; the video gets the files and their sentence spans."""
    lines = script_lines(UPDATE["script"])
    missing = [f"{n}.{i}" for n, l in enumerate(lines, 1) for i in range(len(sentences(l))) if f"{n}.{i}" not in pick]
    if missing:
        raise SystemExit(f"no take picked for {', '.join(missing)}")
    folder = UPDATE["dir"] / f"final-{time.strftime('%Y%m%d-%H%M%S')}"
    (folder / "raw").mkdir(parents=True)
    spans: dict[int, dict] = {}
    files = []
    for n, line in enumerate(lines, 1):
        chunks, marks, pos = [], [], 0
        parts = sentences(line)
        for i in range(len(parts)):
            c, sr = sf.read(src / f"{n:02d}-s{i}-seed{pick[f'{n}.{i}']}.raw.wav", dtype="float32")
            assert sr == SR
            for t, gap in sorted(UPDATE_SPLITS.get(f"{n}.{i}", []), reverse=True):
                c = np.concatenate([c[:int(t * SR)], np.zeros(int(gap * SR), dtype=np.float32), c[int(t * SR):]])
            chunks.append(c)
            marks.append([round(pos / SR, 3), round((pos + c.size) / SR, 3)])
            pos += c.size
            if i < len(parts) - 1:
                chunks.append(np.zeros(int(UPDATE_PAUSES.get(n, SENTENCE_PAUSE) * SR), dtype=np.float32))
                pos += chunks[-1].size
        spans[n] = {"dur": round(pos / SR, 3), "sentences": marks}
        raw = folder / "raw" / f"{n:02d}.wav"
        sf.write(raw, np.concatenate(chunks), SR)
        master(raw, folder / f"{n:02d}.wav")
        files.append(folder / f"{n:02d}.wav")
        print(f"{n:02d}  {pos / SR:4.1f} s  {line}", flush=True)
    gap = np.zeros(int(PAUSE * 48000), dtype=np.float32)
    preview = np.concatenate([x for f in files for x in (sf.read(f, dtype="float32")[0], gap)])
    sf.write(folder / "all.wav", preview, 48000)
    gain = LUFS - lufs(folder / "all.wav")
    for f in [*files, folder / "all.wav"]:
        tmp = f.with_suffix(".tmp.wav")
        master(f, tmp, gain)
        tmp.replace(f)
    (folder / "picks.json").write_text(json.dumps({"from": str(src), "pick": pick}, indent=1) + "\n", encoding="utf-8")
    dst = VIDEO / "public" / UPDATE["public"]
    dst.mkdir(parents=True, exist_ok=True)
    for f in files:
        shutil.copy(f, dst / f.name)
    (VIDEO / "src" / "app" / UPDATE["json"]).write_text(json.dumps(spans, indent=1) + "\n", encoding="utf-8")
    print(f"{folder}: all.wav {preview.size / 48000:.1f} s at {lufs(folder / 'all.wav'):.1f} LUFS; copied to video/public/{UPDATE['public']}, spans in video/src/app/{UPDATE['json']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("takes", nargs="*", default=list(TAKES))
    ap.add_argument("--ref", type=Path)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--keep", help="redo/splice: NEW:OLD sentence pairs reused from the approved take")
    ap.add_argument("--pick", help="splice: NEW:SEED, the take chosen for each new sentence")
    ap.add_argument("--seeds", type=int, default=6, help="redo: takes per new sentence")
    ap.add_argument("--take", help="redo: model settings (default: the line's approved take in FINAL)")
    ap.add_argument("--from", dest="src", type=Path)
    a = ap.parse_args()
    if a.takes[:1] == ["audition"]:
        raise SystemExit(audition(a.seeds, a.seed))
    if a.takes[:1] == ["build"]:
        raise SystemExit(build(a.src, {k: int(v) for k, v in (p.split(":") for p in a.pick.split(","))}))
    if a.takes[:1] == ["redo"]:
        n = int(a.takes[1])
        raise SystemExit(redo(n, pairs(a.keep), a.seeds, a.take or FINAL[n][0], a.seed))
    if a.takes[:1] == ["splice"]:
        raise SystemExit(splice(int(a.takes[1]), pairs(a.keep), pairs(a.pick), a.src))
    for t in a.takes:
        final() if t == "final" else read(t, a.ref, a.seed)
