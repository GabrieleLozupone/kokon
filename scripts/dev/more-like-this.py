"""More like this (#55): how close should a variation stay? Compares today's Regenerate (same
prompt, new seed) with More like this at several strengths, through the real kokon-service.

Start Kokon first (the app or `npx tauri dev`). Private mode: nothing reaches the gallery.

    python -I scripts/dev/more-like-this.py                     # 3 prompts, Fast
    python -I scripts/dev/more-like-this.py --strengths 0.4,0.6 --quality quality

Writes C:\\AI\\sdcpp\\bench\\more-like-this-<time>\\report.html with every image and its time.
"""

import argparse
import html
import json
import os
import time
import urllib.request
from datetime import datetime
from pathlib import Path

DATA = Path(os.environ.get("QLS_DATA_DIR") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "KokonData")
BENCH = Path(r"C:\AI\sdcpp\bench")

PROMPTS = [
    ("A cosy reading corner with a green armchair, a floor lamp and a tall bookshelf, evening light", 501),
    ("A red fox standing in fresh snow at the edge of a pine forest, morning mist", 502),
    ("A minimalist poster with the word \"BLOOM\" above a single pink tulip on a cream background", 503),
]
SEEDS = [9001, 9002]


def call(base, token, method, route, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + route, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=900) as r:
        raw = r.read()
        return json.loads(raw) if r.headers.get_content_type() == "application/json" else raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strengths", default="0.35,0.5,0.65,0.8")
    ap.add_argument("--quality", default="fast")
    a = ap.parse_args()
    strengths = [float(x) for x in a.strengths.split(",")]
    info = json.loads((DATA / "service.json").read_text())
    base, token = f"http://127.0.0.1:{info['port']}/api/v1", info["token"]

    def run(req, path):
        t0 = time.time()
        job = call(base, token, "POST", "/jobs", {**req, "private": True, "client": "bench", "quality": a.quality})
        while True:
            v = call(base, token, "GET", f"/jobs/{job['id']}/wait?timeout=600")
            if v["status"] in ("done", "failed", "cancelled"):
                break
        if v["status"] != "done":
            raise RuntimeError(f"{v['status']}: {v.get('error')}")
        rec = v["results"][0]
        path.write_bytes(call(base, token, "GET", f"/gallery/{rec['id']}/image"))
        return rec, round(time.time() - t0, 1)

    out = BENCH / f"more-like-this-{datetime.now():%Y%m%d-%H%M%S}"
    out.mkdir(parents=True)
    print(f"writing to {out}")
    rows = []
    for n, (prompt, seed) in enumerate(PROMPTS):
        src, secs = run({"prompt": prompt, "mode": "generate", "seed": seed}, out / f"{n}-source.png")
        print(f"{n} source {secs} s")
        cells = [("source", f"{n}-source.png", secs)]
        for s in SEEDS:
            _, secs = run({"prompt": prompt, "mode": "generate", "seed": s}, out / f"{n}-regenerate-{s}.png")
            cells.append((f"Regenerate (seed {s})", f"{n}-regenerate-{s}.png", secs))
            print(f"{n} regenerate {s}: {secs} s")
        for st in strengths:
            for s in SEEDS:
                f = f"{n}-vary{st}-{s}.png"
                _, secs = run({"prompt": src["prompt"], "mode": "generate", "images": [f"gen:{src['id']}"], "vary": st, "seed": s}, out / f)
                cells.append((f"More like this {st} (seed {s})", f, secs))
                print(f"{n} vary {st} {s}: {secs} s")
        rows.append((prompt, cells))
    body = "".join(
        f"<h2>{html.escape(p)}</h2><div class=row>"
        + "".join(f"<figure><a href='{f}'><img src='{f}'></a><figcaption>{html.escape(label)} · {secs} s</figcaption></figure>" for label, f, secs in cells)
        + "</div>"
        for p, cells in rows
    )
    (out / "report.html").write_text(
        "<!doctype html><meta charset=utf-8><title>More like this</title><style>body{font:13px system-ui;background:#111;color:#ddd}"
        ".row{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;width:240px}img{width:240px}a{color:#9cf}</style>" + body,
        encoding="utf-8",
    )
    print(f"report: {out / 'report.html'}")


if __name__ == "__main__":
    main()
