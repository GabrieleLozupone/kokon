"""Chains of edits on the same image through the real kokon-service (#44): where does the
quality go, and what keeps it?

Start Kokon first (the app or `npx tauri dev`); this talks to its service. Everything runs in
private mode, so nothing reaches the gallery or the output folder. For each case it makes a
native 2K source (Quality, fixed seed), then runs the same edits one after the other, each on
the previous result, once per variant:

  fast           today's default: Fast (~1 MP render, 1 MP view of the source, enlarged back)
  quality        Quality preset (2K render), 1 MP view of the source
  quality-full   Quality + reference detail Full (the source seen up to the render's size)
  source         Fast with resolution "Source": render at the source's size if memory allows
  fast-unzoom    fast, then the result is scaled/shifted back onto the previous image when the
                 model redrew the frame larger (it often does by 2-2.5 %), before the next edit
  fast-original  fast, but each edit starts from the model's own render before enlargement
                 (#44's proposal), asking for the source's size again

    python -I scripts/dev/edit-chain.py                       # every variant, 3 cases, 4 edits
    python -I scripts/dev/edit-chain.py --variants fast,quality --cases 1 --edits 2

Writes C:\\AI\\sdcpp\\bench\\edit-chain-<time>\\ (report.html, results.json, every image).
Per step: time, peak VRAM (nvidia-smi), fine detail against the source (1.0 = as sharp),
difference from the source at 512 px, and how much the frame was scaled.
"""

import argparse
import html
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

DATA = Path(os.environ.get("QLS_DATA_DIR") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "KokonData")
BENCH = Path(r"C:\AI\sdcpp\bench")

CASES = [
    {
        "name": "bakery",
        "prompt": "A photo of a small bakery shop front on a sunny street, a wooden sign above the door reads "
        "\"BOULANGERIE MARTIN - PAIN FRAIS DEPUIS 1952\", a chalkboard by the door lists \"Croissant 1.20 / "
        "Baguette 1.10 / Pain au chocolat 1.40\", bicycles, flower pots, sharp detail",
        "seed": 1101,
    },
    {
        "name": "portrait",
        "prompt": "A natural light portrait photo of an elderly fisherman with a white beard and a knitted wool cap, "
        "weathered skin, standing on a harbour with boats and ropes behind him, sharp detail",
        "seed": 2202,
    },
    {
        "name": "poster",
        "prompt": "A flat design concert poster on a wall: big title \"NIGHT TRAIN\", subtitle \"Live at the Old "
        "Station - 14 March - Doors 20:00\", smaller text \"Tickets at the box office and online\", a stylised "
        "locomotive illustration, brick wall around the poster",
        "seed": 3303,
    },
]

EDITS = [
    ("Add a small red bird sitting on the left side of the picture", 11),
    ("Change the colour of the main subject's clothing to dark green", 12),
    ("Add a white coffee cup in the bottom right corner", 13),
    ("Make the light a little warmer, like late afternoon", 14),
    ("Remove the red bird", 15),
]

VARIANTS = {
    "fast": {"quality": "fast"},
    "quality": {"quality": "quality"},
    "quality-full": {"quality": "quality", "advanced": {"reference_detail": "full"}},
    "source": {"quality": "fast", "resolution": "source"},
    "fast-unzoom": {"quality": "fast", "unzoom": True},
    "fast-original": {"quality": "fast", "from_original": True},
}


class Service:
    def __init__(self):
        info = json.loads((DATA / "service.json").read_text())
        self.base = f"http://127.0.0.1:{info['port']}/api/v1"
        self.token = info["token"]

    def call(self, method, route, body=None, timeout=900):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + route, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if r.headers.get_content_type() == "application/json" else raw

    def run(self, req):
        job = self.call("POST", "/jobs", req)
        while True:
            v = self.call("GET", f"/jobs/{job['id']}/wait?timeout=600")
            if v["status"] in ("done", "failed", "cancelled"):
                break
        if v["status"] != "done" or not v["results"]:
            raise RuntimeError(f"job {v['id']} {v['status']}: {v.get('error')}")
        return v

    def save(self, gen_id, path):
        path.write_bytes(self.call("GET", f"/gallery/{gen_id}/image"))

    def import_file(self, path):
        return self.call("POST", "/inputs/import?private=true", {"path": str(path)})["id"]


class VramPeak:
    """Peak GPU memory use (MiB) while a job runs, polled from nvidia-smi."""

    def __init__(self):
        self.peak, self.stop = 0, threading.Event()

    def __enter__(self):
        self.t = threading.Thread(target=self.poll, daemon=True)
        self.t.start()
        return self

    def poll(self):
        while not self.stop.is_set():
            try:
                out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
                self.peak = max(self.peak, int(out.split()[0]))
            except Exception:
                pass
            self.stop.wait(0.5)

    def __exit__(self, *a):
        self.stop.set()
        self.t.join()


def grey(img, long_side=None):
    if long_side:
        k = long_side / max(img.size)
        img = img.resize((max(16, round(img.width * k)), max(16, round(img.height * k))), Image.LANCZOS)
    return np.asarray(img.convert("L"), dtype=np.float32)


def detail(img):
    """Mean absolute Laplacian at full size: fine detail (text edges, skin, hair)."""
    g = grey(img)
    lap = np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:])
    return float(lap.mean())


def warp(im, sc, dx, dy):
    """`im` seen in the reference's frame: x_im = cx + (x - cx) * sc + dx."""
    w, h = im.size
    cx, cy = w / 2, h / 2
    return im.transform(im.size, Image.AFFINE, (sc, 0, cx - cx * sc + dx, 0, sc, cy - cy * sc + dy), resample=Image.BICUBIC)


def frame_change(ref, img):
    """Scale and shift (fractions of the size) mapping `img` onto `ref`, from edge maps at 384 px;
    (1, 0, 0) unless clearly better than leaving it."""
    k = 384 / max(ref.size)
    sz = (max(16, int(ref.width * k)), max(16, int(ref.height * k)))

    def edges(im):
        g = np.asarray(im.convert("L").resize(sz, Image.BILINEAR).filter(ImageFilter.GaussianBlur(0.8)), dtype=np.float32)
        return np.abs(np.diff(g, axis=1))[:-1, :] + np.abs(np.diff(g, axis=0))[:, :-1]

    r = edges(ref)
    small = img.resize(sz, Image.BILINEAR)
    err = lambda sc, dx, dy: float(np.abs(edges(warp(small, sc, dx, dy)) - r)[10:-10, 10:-10].mean())
    base = err(1.0, 0.0, 0.0)
    best = (base, 1.0, 0.0, 0.0)
    for sc in np.arange(0.96, 1.0401, 0.005):
        for dx in range(-8, 9):
            for dy in range(-8, 9):
                e = err(sc, dx, dy)
                if e < best[0]:
                    best = (e, sc, dx, dy)
    e, sc, dx, dy = best
    if e > base * 0.85:
        return 1.0, 0.0, 0.0
    return float(sc), dx / sz[0], dy / sz[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--cases", type=int, default=3)
    ap.add_argument("--edits", type=int, default=4)
    a = ap.parse_args()
    variants = [v.strip() for v in a.variants.split(",") if v.strip()]
    for v in variants:
        if v not in VARIANTS:
            sys.exit(f"unknown variant {v}; known: {', '.join(VARIANTS)}")

    svc = Service()
    out = BENCH / f"edit-chain-{datetime.now():%Y%m%d-%H%M%S}"
    out.mkdir(parents=True)
    print(f"writing to {out}")
    results = {"variants": variants, "cases": [], "edits": EDITS[: a.edits]}

    for case in CASES[: a.cases]:
        print(f"\n== {case['name']}: source")
        with VramPeak() as vp:
            t0 = time.time()
            v = svc.run({"prompt": case["prompt"], "mode": "generate", "quality": "quality", "seed": case["seed"], "aspect_ratio": "1:1", "private": True, "client": "bench"})
        src_path = out / f"{case['name']}-0-source.png"
        svc.save(v["results"][0]["id"], src_path)
        src = Image.open(src_path).convert("RGB")
        d0 = detail(src)
        g0 = grey(src, 512)
        c = {"name": case["name"], "source": src_path.name, "source_seconds": round(time.time() - t0, 1), "runs": {}}
        results["cases"].append(c)
        for vname in variants:
            spec = VARIANTS[vname]
            image = f"gen:{v['results'][0]['id']}"
            prev = src
            steps = []
            for i, (prompt, seed) in enumerate(EDITS[: a.edits], 1):
                req = {"prompt": prompt, "mode": "edit", "images": [image], "seed": seed, "quality": spec["quality"], "private": True, "client": "bench", "preserve_dimensions": True}
                if "resolution" in spec:
                    req["resolution"] = spec["resolution"]
                if "advanced" in spec:
                    req["advanced"] = spec["advanced"]
                if spec.get("from_original"):
                    # Auto renders at Fast's size and enlarges to this exact size, as from the enlarged image.
                    req["width"], req["height"] = src.width, src.height
                print(f"  {vname} {i}: {prompt}", flush=True)
                with VramPeak() as vp:
                    t0 = time.time()
                    try:
                        job = svc.run(req)
                    except Exception as e:
                        print(f"    failed: {e}")
                        steps.append({"error": str(e)})
                        break
                    secs = time.time() - t0
                rec = job["results"][0]
                p = out / f"{case['name']}-{vname}-{i}.png"
                svc.save(rec["id"], p)
                img = Image.open(p).convert("RGB")
                sc, fx, fy = frame_change(prev, img) if img.size == prev.size else (1.0, 0.0, 0.0)
                image = f"gen:{rec['id']}"
                if spec.get("unzoom") and (sc, fx, fy) != (1.0, 0.0, 0.0):
                    img = warp(img, sc, fx * img.width, fy * img.height)
                    q = out / f"{case['name']}-{vname}-{i}-unzoomed.png"
                    img.save(q)
                    image = f"input:{svc.import_file(q)}"
                    p = q
                orig = (rec.get("pipeline") or {}).get("original_path")
                if spec.get("from_original") and orig and os.path.exists(orig):
                    image = f"input:{svc.import_file(Path(orig))}"
                plan = job.get("plan") or {}
                g = grey(img, 512) if img.size == src.size else None
                steps.append(
                    {
                        "file": p.name,
                        "seconds": round(secs, 1),
                        "vram_peak_mib": vp.peak,
                        "working": plan.get("working"),
                        "references": [r.get("canvas", {}).get("canvas") for r in plan.get("references", [])],
                        "detail_vs_source": round(detail(img) / d0, 3),
                        "diff_from_source": round(float(np.abs(g - g0).mean()), 2) if g is not None else None,
                        "frame_scale": round(sc, 3),
                        "notes": job.get("notes", []),
                    }
                )
                s = steps[-1]
                print(f"    {s['seconds']} s, {s['vram_peak_mib']} MiB, detail {s['detail_vs_source']}, diff {s['diff_from_source']}, scale {s['frame_scale']}", flush=True)
                prev = img
            c["runs"][vname] = steps
            (out / "results.json").write_text(json.dumps(results, indent=1))
    write_report(out, results)
    print(f"\nreport: {out / 'report.html'}")


def write_report(out, results):
    rows = []
    for c in results["cases"]:
        rows.append(f"<h2>{html.escape(c['name'])}</h2><p><a href='{c['source']}'><img src='{c['source']}'></a><br>source</p>")
        rows.append("<table><tr><th>variant</th>" + "".join(f"<th>{i}. {html.escape(e[0])}</th>" for i, e in enumerate(results["edits"], 1)) + "</tr>")
        for vname, steps in c["runs"].items():
            cells = []
            for s in steps:
                if "error" in s:
                    cells.append(f"<td>failed: {html.escape(s['error'])}</td>")
                    continue
                cells.append(
                    f"<td><a href='{s['file']}'><img src='{s['file']}'></a><br>{s['seconds']} s · {s['vram_peak_mib']} MiB<br>"
                    f"detail {s['detail_vs_source']} · diff {s['diff_from_source']} · scale {s['frame_scale']}</td>"
                )
            rows.append(f"<tr><th>{html.escape(vname)}</th>{''.join(cells)}</tr>")
        rows.append("</table>")
    (out / "report.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Edit chain</title><style>body{font:13px system-ui;background:#111;color:#ddd}"
        "img{width:260px}td,th{vertical-align:top;padding:4px}a{color:#9cf}</style>"
        "<p>Click an image for full size. detail = fine detail against the source (1 = as sharp); diff = mean grey difference from "
        "the source at 512 px (lower = less drift); scale = frame redrawn larger (&lt; 1) or smaller.</p>" + "".join(rows),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
