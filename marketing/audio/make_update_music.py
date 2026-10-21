"""The music of the "Kokon 0.10" update video, cut from an ACE-Step take (gen_music.py update).

    D:/AI/tts/.venv/Scripts/python make_update_music.py [1|1b|3]   -> ../video/public/<out>

Both takes are 118 BPM (beats every 0.50849 s, grids measured with librosa). The video needs the
take's drop on its beat 26 (the image hatching) and about 12 bars after it, then a stop for the
last words. Each plan lists the take's bars to play (bar 0 = the take's first bar line); every
join is on a bar line with a 10 ms crossfade.

- Take 1 (music-0.10.m4a): quiet build, drop on bar line 16.252 s, 8 bars, dead stop. Plays the
  26 beats before the drop, bars 1-7, bars 4-7 again, bar 8 with the stop.
- Take 3 (music-0.10-take3.m4a): groove from the start, thinning, a build, a near-silent break,
  the drop at 24.44 s (bar 12), 4 bars, an ending bar. Two beats of silence, then bars 6-11 (the
  break under the logo forming), the drop, bars 12-15, the drop again (on the LoRA part), bars
  13-15 and the ending bar.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
BEAT = 60 / 118
BAR = 4 * BEAT
FADE = 0.010

PLANS = {
    # first: time of the take's bar 0; lead: beats of silence first; bars: [from, to) bar ranges;
    # tail: seconds kept after the last bar (the take's own decay).
    1: {"take": "update-20261020-175836-1.wav", "out": "music-0.10.m4a", "first": 16.252 - 8 * BAR,
        "lead": 0, "bars": [(1.5, 15), (11, 15), (15, 16)], "tail": 3.5},
    # Take 1 with one more groove bar (bars 3-7 repeated): the video's Prompt+ model part is a bar
    # longer. Stop at 39.64 s.
    "1b": {"take": "update-20261020-175836-1.wav", "out": "music-0.10-long.m4a", "first": 16.252 - 8 * BAR,
           "lead": 0, "bars": [(1.5, 15), (10, 15), (15, 16)], "tail": 3.5},
    3: {"take": "update-20261020-175836-3.wav", "out": "music-0.10-take3.m4a", "first": 0.0287,
        "lead": 2, "bars": [(6, 16), (12, 16), (13, 17)], "tail": 2.5},
}


def main(n: int | str) -> None:
    plan = PLANS[n]
    y, sr = sf.read(HERE / "takes" / plan["take"], dtype="float32", always_2d=True)
    at = lambda t: int(round(t * sr))
    bar = lambda i: plan["first"] + i * BAR
    parts = [np.zeros((at(plan["lead"] * BEAT), y.shape[1]), np.float32)] if plan["lead"] else []
    last = len(plan["bars"]) - 1
    for k, (a, b) in enumerate(plan["bars"]):
        end = bar(b) + (plan["tail"] if k == last else 0)
        parts.append(y[at(bar(a)):at(end)])
    n_f = at(FADE)
    ramp = np.linspace(0, 1, n_f, dtype=np.float32)[:, None]
    out = parts[0]
    for p in parts[1:]:
        # The tail of what came before overlaps the head of the next part.
        mixed = out[-n_f:] * (1 - ramp) + p[:n_f] * ramp
        out = np.concatenate([out[:-n_f], mixed, p[n_f:]])
    wav = HERE / "takes" / Path(plan["out"]).with_suffix(".wav").name
    sf.write(wav, out, sr)
    dst = HERE.parent / "video" / "public" / plan["out"]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "192k", str(dst)], check=True)
    # Where the music falls silent: the last 50 ms window above -40 dB.
    mono = np.abs(out).max(axis=1)
    win = at(0.05)
    loud = [i for i in range(0, len(mono) - win, win) if mono[i:i + win].max() > 0.01]
    print(f"{dst}: {len(out) / sr:.2f} s, music silent from {(loud[-1] + win) / sr:.2f} s")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "1"
    main(arg if arg in PLANS else int(arg))
