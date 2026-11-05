"""Why brushed edits lose to plain edits, and why Expand's new area doesn't match: same-seed A/B of
Kokon's current requests against alternatives, on the example images (varied edits, sizes, aspects).

Close Kokon first: this starts its own sd-server with the flags of Kokon's last launch (see
compare-fast-modes.py). Kokon's own requests come from `cargo run --example edit_lab`, so the
"kokon" column is exactly what the app sends today, post-processed by the app's own code.

Brushed edits (inpaint), per case:
  kokon       today: clean region as <image1> + marked guide <image2>, latent mask, soft paste-back
  nomask      the same request without the latent mask (the model edits the region freely), same paste-back
  annot       one image: the region with the mask outlined in color, "change what is inside the outline"
              (Qwen-Image 2.1 circle-guided editing), no latent mask, same paste-back
  plain       a plain described edit of the whole image (what users compare against), shown as is
  plain+paste the plain edit pasted back with Kokon's soft mask (rest of the image untouched)
  *+harm      post-processing only (no new run): the patch's low-frequency colour shift measured just
              outside the mask is carried inside it before pasting (no colour step at the border)
Expand (outpaint), per case:
  kokon       today: source alone as reference, init padded with the mean colour, latent mask
  padref      reference = the padded canvas (original in place, grey borders), latent mask
  padref-free padded canvas reference, no latent mask, original pasted back after
  blurref     like padref, borders filled with a blurred continuation of the image instead of grey
  lora        ausboss Outpaint v2 (split copy) at 1.0 on the padded canvas, its own prompt, no latent mask
  *+harm      post-processing only, as above (colour shift measured inside the original's border)

    python -I scripts/dev/inpaint-explore.py                      # quick set: 10 runs (~8 min)
    python -I scripts/dev/inpaint-explore.py --set fix            # the colour match / Replace fixes: 7 runs, before vs after
    python -I scripts/dev/inpaint-explore.py --set wide           # the same fixes on 11 harder cases (generalization check)
    python -I scripts/dev/inpaint-explore.py --full               # every case and variant (~70 runs, 30-60 min)
    python -I scripts/dev/inpaint-explore.py --full --only inpaint --cases street-remove,cabin-add
    python -I scripts/dev/inpaint-explore.py --out <earlier run>  # resume: skips finished images

Writes <out>/report.html (originals, results, zoomed seams, metrics), results.json and the images.
Metrics: `step` = colour step across the paste border beyond the original's own (0-255, lower is
better), `change` = mean change inside the mask (a near-0 edit did nothing), `drift` = shift of
the regenerated original area in px (only for runs without the latent mask).
"""

import argparse
import base64
import html
import importlib.util
import io
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
EXAMPLES = ROOT / "assets" / "examples"
_spec = importlib.util.spec_from_file_location("compare_fast_modes", HERE / "compare-fast-modes.py")
cfm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cfm)
_spec = importlib.util.spec_from_file_location("lora_explore", HERE / "lora-explore.py")
lex = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lex)

OUTPAINT_LORA = "qwen-image-2.1-outpaint-v2.split.safetensors"
COLORS = {"red": (255, 0, 0), "green": (0, 230, 0), "blue": (0, 80, 255), "magenta": (255, 0, 255)}

# ---------------------------------------------------------------------------------------
# Cases. Masks: a file in assets/examples, or an ellipse (x0, y0, x1, y1) as fractions of the
# image. `scale` makes a smaller copy of the source first (low-resolution inputs).
# ---------------------------------------------------------------------------------------

INPAINT = [
    # id, source, scale, mask, action, brush prompt, plain-edit prompt (the location in words)
    ("street-remove", "street", 1.0, "street-mask.png", "remove", "the red scooter", "Remove the red scooter. Keep everything else unchanged."),
    ("street-add", "street", 1.0, "street-add-mask.png", "add", "a ginger cat sitting on the cobblestones, looking at the camera",
     "Add a ginger cat sitting on the cobblestones in front of the red scooter, looking at the camera. Keep everything else unchanged."),
    ("street-pot", "street", 1.0, (0.22, 0.78, 0.36, 0.99), "edit", "make the flower pot glossy blue ceramic",
     "Make the terracotta pot of the lemon tree glossy blue ceramic. Keep everything else unchanged."),
    ("cabin-replace", "cabin", 1.0, (0.52, 0.30, 0.81, 0.64), "replace", "a modern glass house with a flat roof",
     "Replace the wooden cabin with a modern glass house with a flat roof. Keep everything else unchanged."),
    ("cabin-add", "cabin", 1.0, (0.30, 0.70, 0.58, 0.88), "add", "a small red rowing boat",
     "Add a small red rowing boat on the lake in the lower left. Keep everything else unchanged."),
    ("bakery-window", "bakery", 1.0, (0.21, 0.36, 0.42, 0.79), "edit", "fill the window with colourful macarons",
     "Fill the left shop window with colourful macarons instead of bread. Keep everything else unchanged."),
    ("lighthouse-remove", "lighthouse", 1.0, (0.43, 0.21, 0.61, 0.69), "remove", "the lighthouse",
     "Remove the lighthouse. Keep everything else unchanged."),
    ("potter-bowl", "potter", 1.0, (0.33, 0.64, 0.66, 0.83), "replace", "a small green potted cactus",
     "Replace the blue bowl she is holding with a small green potted cactus. Keep everything else unchanged."),
    # Low resolution: the same edits on small copies.
    ("street-pot-small", "street", 0.4, (0.22, 0.78, 0.36, 0.99), "edit", "make the flower pot glossy blue ceramic",
     "Make the terracotta pot of the lemon tree glossy blue ceramic. Keep everything else unchanged."),
    ("lighthouse-remove-small", "lighthouse", 0.58, (0.43, 0.21, 0.61, 0.69), "remove", "the lighthouse",
     "Remove the lighthouse. Keep everything else unchanged."),
]

OUTPAINT = [
    # id, source, scale, (left, right, top, bottom) as fractions of the source size, prompt
    ("lighthouse-wide", "lighthouse", 1.0, (0.4, 0.4, 0.0, 0.0), "continue the rocky coastline and the turquoise sea at golden sunset"),
    ("lighthouse-wide-small", "lighthouse", 0.58, (0.4, 0.4, 0.0, 0.0), "continue the rocky coastline and the turquoise sea at golden sunset"),
    ("potter-landscape", "potter", 1.0, (0.6, 0.6, 0.0, 0.0), "continue the pottery studio"),
    ("street-up", "street", 1.0, (0.0, 0.0, 0.35, 0.0), "continue the buildings and the blue sky"),
    ("cabin-zoomout", "cabin", 1.0, (0.2, 0.2, 0.2, 0.2), "continue the lake, the forest and the mountains"),
    ("bakery-right-small", "bakery", 0.4, (0.0, 0.6, 0.0, 0.0), "continue the street with the next shop"),
]

# Quick set (the default): 2 brushed edits x (kokon, annot, plain) + 2 Expands x (kokon, padref) = 10 runs;
# plain+paste and the +harm columns are post-processing only.
QUICK_CASES = {"cabin-add", "potter-bowl", "lighthouse-wide-small", "potter-landscape"}
QUICK_VARIANTS = {"kokon", "annot", "plain", "padref"}

# Fix check (--set fix): today's Kokon only, each result also finished without the colour match
# ("kokon-nomatch" = the earlier paste-back, same raw image). Real failures from Gabriele's gallery
# (10-24 suit Expand: colour band; 10-27 tourists: line through the fountain) + Replace cases + controls.
PICS = Path.home() / "Pictures" / "Kokon"
FIX_INPAINT = [
    ("potter-bowl", "potter", 1.0, (0.33, 0.64, 0.66, 0.83), "replace", "a small green potted cactus", None),
    ("cabin-replace", "cabin", 1.0, (0.52, 0.30, 0.81, 0.64), "replace", "a modern glass house with a flat roof", None),
    ("tourists-remove", PICS / "use-cases-2k" / "1-famiglia" / "01-turisti-originale.png", 1.0,
     PICS / "use-cases-2k" / "1-famiglia" / "01-turisti-mask.png", "remove", "the tourists", None),
    ("cabin-add", "cabin", 1.0, (0.30, 0.70, 0.58, 0.88), "add", "a small red rowing boat", None),
]
# Generalization check (--set wide): cases chosen to stress the fixes, with Gabriele's real jobs at
# their own seed and quality (last element). Expand: huge/all-side/low-res/subject at the seam;
# brush: removal, low-res edit, detailed edit, Replace on clothing (shape must survive), a real removal.
KDATA = Path.home() / "AppData" / "Local" / "KokonData"
WIDE_INPAINT = [
    ("street-remove", "street", 1.0, "street-mask.png", "remove", "the red scooter", None),
    ("street-pot-small", "street", 0.4, (0.22, 0.78, 0.36, 0.99), "edit", "make the flower pot glossy blue ceramic", None),
    ("bakery-window", "bakery", 1.0, (0.21, 0.36, 0.42, 0.79), "edit", "fill the window with colourful macarons", None),
    ("potter-apron", "potter", 1.0, (0.26, 0.42, 0.74, 1.0), "replace", "a dark red denim apron", None),
    ("film-person", PICS / "2026-10-14" / "213126-anamorphic-widescreen-film-still-of-five-435749417.png", 1.0,
     KDATA / "inputs" / "9d57b29281de1f44a62e10a8.png", "remove", "the person", None, {"seed": 939432853, "quality": "quality"}),
]
WIDE_OUTPAINT = [
    ("room-ultrawide", PICS / "2026-10-22" / "180422-image-1104108829.png", 1.0, (1776 / 1824, 1776 / 1824, 0.0, 0.0), "complete the room and the scene",
     {"seed": 1887149555, "quality": "quality"}),
    ("mother-wide", PICS / "2026-10-23" / "181836-mamma-con-un-bambino-88598495.png", 1.0, (1365 / 2048, 1366 / 2048, 0.0, 0.0), "Expand the image",
     {"seed": 1462041171, "quality": "quality"}),
    ("small-allsides", PICS / "2026-10-23" / "205132-togli-il-bicchiere-di-succo-e-398294820.png", 1.0, (384 / 768, 384 / 768, 344 / 1376, 344 / 1376), "Extend",
     {"seed": 1071423534, "quality": "fast"}),
    ("kitchen-wide", PICS / "2026-10-09" / "161522-one-photograph-the-pasta-colosseum-with-727053259.png", 1.0, (869 / 2368, 870 / 2368, 0.0, 0.0),
     "Continue the same kitchen in the same warm light", {"seed": 1450379103, "quality": "quality"}),
    ("street-up", "street", 1.0, (0.0, 0.0, 0.35, 0.0), "continue the buildings and the blue sky"),
    ("bakery-right-small", "bakery", 0.4, (0.0, 0.6, 0.0, 0.0), "continue the street with the next shop"),
]
FIX_OUTPAINT = [
    ("suit-expand", PICS / "2026-10-24" / "182119-imagine-the-best-hair-cut-for-758384913.png", 1.0, (796 / 2048, 797 / 2048, 0.0, 0.0), "Expand the frame"),
    ("lighthouse-wide-small", "lighthouse", 0.58, (0.4, 0.4, 0.0, 0.0), "continue the rocky coastline and the turquoise sea at golden sunset"),
    ("potter-landscape", "potter", 1.0, (0.6, 0.6, 0.0, 0.0), "continue the pottery studio"),
]

# ---------------------------------------------------------------------------------------
# Image helpers (numpy, no scipy)
# ---------------------------------------------------------------------------------------


def arr(img):
    return np.asarray(img.convert("RGB"), dtype=np.float32)


def mask_arr(img):
    return np.asarray(img.convert("L"), dtype=np.float32) / 255.0


def to_img(a):
    return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8))


def to_mask(m):
    return Image.fromarray(np.clip(m * 255 + 0.5, 0, 255).astype(np.uint8), "L")


def box(a, r):
    """Mean over a (2r+1)² window, edges clamped. Works on HxW or HxWxC."""
    if r <= 0:
        return a
    for axis in (0, 1):
        pad = [(0, 0)] * a.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis, dtype=np.float64)
        n = c.shape[axis] - 2 * r - 1
        hi = c[2 * r + 1 :] if axis == 0 else c[:, 2 * r + 1 :]
        lo = c[:n] if axis == 0 else c[:, :n]
        a = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return a


def dilate(m, r):
    return (box((m > 0.5).astype(np.float32), r) > 1e-4).astype(np.float32)


def erode(m, r):
    return 1.0 - dilate(1.0 - (m > 0.5), r)


def fill(values, weight):
    """Push-pull: a smooth continuation of `values` (HxWxC) from where `weight` > 0 to everywhere."""
    levels = [(values * weight[..., None], weight)]
    while max(levels[-1][1].shape) > 1:
        v, w = levels[-1]
        h2, w2 = (v.shape[0] + 1) // 2, (v.shape[1] + 1) // 2
        vp = np.pad(v, ((0, h2 * 2 - v.shape[0]), (0, w2 * 2 - v.shape[1]), (0, 0)))
        wp = np.pad(w, ((0, h2 * 2 - w.shape[0]), (0, w2 * 2 - w.shape[1])))
        levels.append((vp.reshape(h2, 2, w2, 2, -1).sum((1, 3)), wp.reshape(h2, 2, w2, 2).sum((1, 3))))
    v, w = levels[-1]
    cur = v / np.maximum(w, 1e-6)[..., None]
    for v, w in reversed(levels[:-1]):
        up = np.repeat(np.repeat(cur, 2, 0), 2, 1)[: v.shape[0], : v.shape[1]]
        a = np.clip(w, 0, 1)[..., None]
        cur = np.where(w[..., None] > 0, v / np.maximum(w, 1e-6)[..., None], 0) * a + up * (1 - a)
    return cur


def harmonize(result, reference, known, target, r):
    """Adds to `result` (inside `target`) the smooth low-frequency difference reference - result
    measured where `known` is 1, so the two agree in colour at their border."""
    s = 4  # work at a quarter of the size: the shift is low-frequency
    small = lambda a: np.asarray(Image.fromarray(a.astype(np.float32)).resize((max(1, a.shape[1] // s), max(1, a.shape[0] // s)), Image.BILINEAR)) if a.ndim == 2 else np.stack([small(a[..., c]) for c in range(a.shape[2])], -1)
    diff = box(reference, r) - box(result, r)
    k = small(known)
    d = fill(small(diff), (k > 0.5).astype(np.float32))
    d = box(d, max(1, r // s))
    d = np.stack([np.asarray(Image.fromarray(d[..., c]).resize((result.shape[1], result.shape[0]), Image.BILINEAR)) for c in range(3)], -1)
    return result + d * target[..., None]


def seam_step(result, original, m, r):
    """Mean colour step across the border of mask `m` (local means just inside vs just outside),
    minus the same quantity on `original` (the scene's own edges) when there is one."""
    inner, outer = erode(m, 2) - erode(m, 2 + r), dilate(m, 2 + r) - dilate(m, 2)
    edge = dilate(m, 1) - erode(m, 1)
    b = r + 3  # the image border is not a seam
    edge[:b], edge[-b:], edge[:, :b], edge[:, -b:] = 0, 0, 0, 0
    if edge.sum() < 10 or inner.sum() < 10 or outer.sum() < 10:
        return None

    def step(img):
        mi = box(img * inner[..., None], 2 * r) / np.maximum(box(inner, 2 * r), 1e-6)[..., None]
        mo = box(img * outer[..., None], 2 * r) / np.maximum(box(outer, 2 * r), 1e-6)[..., None]
        return float((np.linalg.norm(mi - mo, axis=-1) * edge).sum() / edge.sum())

    return round(step(result) - (step(original) if original is not None else 0.0), 1)


def paste_back_mask(w, h, exp, feather):
    """pipeline/imaging::paste_back_mask: 1 inside the original, ramping to 0 over `feather` px on expanded edges."""
    f = max(feather, 1)
    x, y = np.arange(w)[None, :].astype(np.float32), np.arange(h)[:, None].astype(np.float32)
    v = np.ones((h, w), np.float32)
    ramp = lambda d: np.minimum((d + 0.5) / f, 1.0)
    if exp["left"]:
        v = np.minimum(v, ramp(x))
    if exp["right"]:
        v = np.minimum(v, ramp(w - 1 - x))
    if exp["top"]:
        v = np.minimum(v, ramp(y))
    if exp["bottom"]:
        v = np.minimum(v, ramp(h - 1 - y))
    return v


def b64img(s):
    img = Image.open(io.BytesIO(base64.b64decode(s)))
    img.load()
    return img


# ---------------------------------------------------------------------------------------
# Kokon's requests (edit_lab example)
# ---------------------------------------------------------------------------------------


def edit_lab(*args):
    exe = ROOT / "target" / "debug" / "examples" / ("edit_lab.exe" if sys.platform == "win32" else "edit_lab")
    subprocess.run([str(exe), *map(str, args)], check=True, cwd=ROOT)


def build_edit_lab():
    subprocess.run(["cargo", "build", "-q", "-p", "qls-core", "--example", "edit_lab"], check=True, cwd=ROOT)


class Run:
    def __init__(self, out, seed, quality, dry=False, variants=None, fix=False):
        self.out, self.seed, self.quality, self.dry, self.variants, self.fix = out, seed, quality, dry, variants, fix
        rp = out / "results.json"
        # Earlier records stay (a resumed or partial run only replaces the ones it redoes).
        self.results = json.loads(rp.read_text(encoding="utf-8")) if rp.is_file() else []

    def gen(self, name, body, seed=None):
        """Raw backend image for `body` (cached in raw/<name>.png)."""
        path = self.out / "raw" / f"{name}.png"
        secs_p = path.with_suffix(".json")
        if path.is_file():
            return path, json.loads(secs_p.read_text()) if secs_p.is_file() else None
        path.parent.mkdir(exist_ok=True)
        (path.parent / f"{name}.request.json").write_text(json.dumps({k: (v if not isinstance(v, str) or len(v) < 500 else f"<{len(v)} chars>") for k, v in body.items()}, indent=1))
        body = {**body, "seed": self.seed if seed is None else seed}
        if self.dry:
            # No server: the init image (or image 1) stands in for the result, to test the script.
            img, secs = b64img(body.get("init_image") or body["ref_images"][0]).convert("RGB").resize((body["width"], body["height"])), 0.0
        else:
            img, secs = lex.generate(body)
        img.save(path)
        secs_p.write_text(json.dumps(round(secs, 1)))
        return path, round(secs, 1)

    def record(self, section, case, variant, final, secs, prompt, **metrics):
        name = f"{section}-{case}-{variant}"
        final.convert("RGB").save(self.out / f"{name}.jpg", quality=92)
        rec = {"section": section, "case": case, "variant": variant, "file": f"{name}.jpg", "seconds": secs, "prompt": prompt, **metrics}
        self.results = [r for r in self.results if r["file"] != rec["file"]] + [rec]
        (self.out / "results.json").write_text(json.dumps(self.results, indent=1), encoding="utf-8")
        print(f"{section:8} {case:24} {variant:18} {secs or 0:6.1f} s  " + "  ".join(f"{k}={v}" for k, v in metrics.items() if v is not None))


def source(out, name, scale):
    """An example image by name, or any image file (a Path)."""
    src = Image.open(name if isinstance(name, Path) else EXAMPLES / f"{name}.jpg").convert("RGB")
    if scale != 1.0:
        src = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
    p = out / "inputs" / f"{name.stem if isinstance(name, Path) else name}@{scale:g}.png"
    p.parent.mkdir(exist_ok=True)
    src.save(p)
    return src, p


def case_mask(out, cid, spec, size):
    if isinstance(spec, (str, Path)):
        m = Image.open(spec if isinstance(spec, Path) else EXAMPLES / spec).convert("L").resize(size, Image.BILINEAR)
    else:
        m = Image.new("L", size, 0)
        w, h = size
        ImageDraw.Draw(m).ellipse((spec[0] * w, spec[1] * h, spec[2] * w, spec[3] * h), fill=255)
    p = out / "inputs" / f"{cid}-mask.png"
    m.save(p)
    return m, p


def annotate(img_b64, mask_b64, color):
    """`img` with the border of the mask drawn as a coloured outline (the mask is resized to the image)."""
    img = b64img(img_b64).convert("RGB")
    m = mask_arr(b64img(mask_b64).resize(img.size, Image.BILINEAR))
    t = max(3, round(max(img.size) * 0.005))
    ring = dilate(m, t) - (m > 0.5)
    a = arr(img)
    a[ring > 0.5] = color
    return to_img(a)


def inpaint_case(run, c):
    cid, name, scale, mspec, action, brush, plain_prompt = c[:7]
    opts = c[7] if len(c) > 7 else {}
    seed, quality = opts.get("seed"), opts.get("quality", run.quality)
    src, src_p = source(run.out, name, scale)
    m, m_p = case_mask(run.out, cid, mspec, src.size)
    d = run.out / "requests" / cid
    edit_lab("prepare", d, quality, src_p, "inpaint", m_p, action, brush)
    if plain_prompt:
        edit_lab("prepare", d / "plain", quality, src_p, "edit", plain_prompt)
    req = json.loads((d / "request.json").read_text())
    meta = json.loads((d / "meta.json").read_text())
    reg = meta["inpaint_region"]
    blend = mask_arr(Image.open(d / "blend.png"))
    full_blend = np.zeros((src.height, src.width), np.float32)
    full_blend[reg["y"] : reg["y"] + reg["height"], reg["x"] : reg["x"] + reg["width"]] = blend
    color = next((k for k in COLORS if f"marked in {k}" in req["prompt"]), "red")
    S = arr(src)
    r = max(3, round(max(src.size) * 0.006))

    def metrics(final):
        F = arr(final)
        inside = full_blend > 0.5
        return {"step": seam_step(F, S, full_blend, r), "change": round(float(np.abs(F - S)[inside].mean()), 1)}

    def unblended(raw_path):
        """The raw patch at source size inside the region (no paste-back), the rest = original."""
        raw = Image.open(raw_path).convert("RGB")
        ct = meta["content"]
        patch = raw.crop((ct["x"], ct["y"], ct["x"] + ct["width"], ct["y"] + ct["height"])).resize((reg["width"], reg["height"]), Image.LANCZOS)
        full = S.copy()
        full[reg["y"] : reg["y"] + reg["height"], reg["x"] : reg["x"] + reg["width"]] = arr(patch)
        return full

    def harm(full_patch):
        """Colour-harmonized paste-back: the shift measured in a band just outside the paste area."""
        support = full_blend > 0.004
        known = dilate(support, 3 * r) - dilate(support, r)
        region = np.zeros_like(full_blend)
        region[reg["y"] : reg["y"] + reg["height"], reg["x"] : reg["x"] + reg["width"]] = 1
        known *= region
        h = harmonize(full_patch, S, known, dilate(support, r), r)
        return to_img(S * (1 - full_blend[..., None]) + h * full_blend[..., None])

    bodies = {
        "kokon": req,
        "nomask": {k: v for k, v in req.items() if k not in ("mask_image",)},
    }
    a = {k: v for k, v in req.items() if k not in ("mask_image", "init_image", "strength")}
    a["ref_images"] = [lex.cfm.b64png(annotate(req["ref_images"][0], req["mask_image"], COLORS[color]))]
    a["image_preprocess"] = ["target=ref,mode=none"]
    subject = brush if action != "remove" else f"remove {brush}"
    a["prompt"] = (
        f"Edit only the area inside the {color} outline in <image1>: {subject}. "
        f"Blend the change seamlessly into the scene and remove the {color} outline. Keep everything outside the outline exactly as it is."
    )
    bodies["annot"] = a
    for v, body in bodies.items():
        if run.variants and v not in run.variants:
            continue
        raw_p, secs = run.gen(f"in-{cid}-{v}", body, seed)
        fin = run.out / "raw" / f"in-{cid}-{v}-final.png"
        edit_lab("finish", d, raw_p, fin)
        final = Image.open(fin).convert("RGB")
        run.record("inpaint", cid, v, final, secs, body["prompt"], **metrics(final))
        if run.fix:
            edit_lab("finish", d, raw_p, fin.with_name(fin.stem + "-nomatch.png"), "nomatch")
            nm = Image.open(fin.with_name(fin.stem + "-nomatch.png")).convert("RGB")
            run.record("inpaint", cid, v + "-nomatch", nm, None, "(same raw, earlier paste-back)", **metrics(nm))
            continue
        h = harm(unblended(raw_p))
        run.record("inpaint", cid, v + "+harm", h, None, "(post only)", **metrics(h))

    src.save(run.out / f"inpaint-{cid}-original.jpg", quality=92)
    over = arr(src)
    over[full_blend > 0.5] = over[full_blend > 0.5] * 0.5 + np.array(COLORS[color]) * 0.5
    to_img(over).save(run.out / f"inpaint-{cid}-mask.jpg", quality=88)
    if not plain_prompt or (run.variants and "plain" not in run.variants):
        return
    preq = json.loads((d / "plain" / "request.json").read_text())
    raw_p, secs = run.gen(f"in-{cid}-plain", preq)
    fin = run.out / "raw" / f"in-{cid}-plain-final.png"
    edit_lab("finish", d / "plain", raw_p, fin)
    plain = Image.open(fin).convert("RGB").resize(src.size, Image.LANCZOS)
    P = arr(plain)
    run.record("inpaint", cid, "plain", plain, secs, plain_prompt, step=None, change=round(float(np.abs(P - S)[full_blend > 0.5].mean()), 1),
               outside=round(float(np.abs(P - S)[full_blend < 0.01].mean()), 1), drift=lex.drift_px(src, plain))
    pasted = to_img(S * (1 - full_blend[..., None]) + P * full_blend[..., None])
    run.record("inpaint", cid, "plain+paste", pasted, None, "(post only)", **metrics(pasted))
    run.record("inpaint", cid, "plain+paste+harm", harm(P), None, "(post only)", **metrics(harm(P)))


def outpaint_case(run, c):
    cid, name, scale, frac, prompt = c[:5]
    opts = c[5] if len(c) > 5 else {}
    seed, quality = opts.get("seed"), opts.get("quality", run.quality)
    src, src_p = source(run.out, name, scale)
    px = [round(frac[0] * src.width), round(frac[1] * src.width), round(frac[2] * src.height), round(frac[3] * src.height)]
    d = run.out / "requests" / cid
    edit_lab("prepare", d, quality, src_p, "outpaint", *px, prompt)
    req = json.loads((d / "request.json").read_text())
    meta = json.loads((d / "meta.json").read_text())
    op = meta["outpaint"]
    exp, fs, rf = op["expansion"], op["final_size"], op["source_rect_final"]
    W, H = fs["width"], fs["height"]
    feather = meta["feather"]
    keep = np.zeros((H, W), np.float32)
    keep[rf["y"] : rf["y"] + rf["height"], rf["x"] : rf["x"] + rf["width"]] = 1
    paste = np.zeros((H, W), np.float32)
    paste[rf["y"] : rf["y"] + rf["height"], rf["x"] : rf["x"] + rf["width"]] = paste_back_mask(rf["width"], rf["height"], exp, feather)
    S = np.zeros((H, W, 3), np.float32)
    S[rf["y"] : rf["y"] + rf["height"], rf["x"] : rf["x"] + rf["width"]] = arr(src)
    r = max(3, round(max(W, H) * 0.006))

    def metrics(final, raw_full=None):
        # No original outside the kept area: the raw step, to compare variants with each other.
        m = {"step": seam_step(arr(final), None, keep, r)}
        if raw_full is not None:
            x, y, w, h = rf["x"], rf["y"], rf["width"], rf["height"]
            m["drift"] = lex.drift_px(src, to_img(raw_full[y : y + h, x : x + w]))
        return m

    def raw_full(raw_p):
        raw = Image.open(raw_p).convert("RGB")
        ct = meta["content"]
        return arr(raw.crop((ct["x"], ct["y"], ct["x"] + ct["width"], ct["y"] + ct["height"])).resize((W, H), Image.LANCZOS))

    def harm(full):
        band = keep - erode(keep, 3 * r)
        h = harmonize(full, S, band * erode(keep, r // 2 + 1), 1 - erode(keep, r), r)
        return to_img(S * paste[..., None] + h * (1 - paste[..., None]))

    # The padded canvas at the working size, as the reference image (original in place, grey or blurred borders).
    canvas = b64img(req["init_image"]).convert("RGB")
    sw = op["source_rect_working"]
    cmask = np.zeros((canvas.height, canvas.width), np.float32)
    cmask[sw["y"] : sw["y"] + sw["height"], sw["x"] : sw["x"] + sw["width"]] = 1
    grey = arr(canvas)
    grey[cmask < 0.5] = 128
    C = arr(canvas)
    blurred = fill(box(C, 2), cmask)
    blurred = box(blurred, max(4, canvas.width // 64))
    blurred = C * cmask[..., None] + blurred * (1 - cmask[..., None])
    bodies = {"kokon": req}
    padref = {**req, "ref_images": [lex.cfm.b64png(to_img(grey))]}
    bodies["padref"] = padref
    bodies["padref-free"] = {k: v for k, v in padref.items() if k not in ("mask_image", "init_image", "strength")} | {"image_preprocess": ["target=ref,mode=none"]}
    bodies["blurref"] = {**req, "ref_images": [lex.cfm.b64png(to_img(blurred))], "init_image": lex.cfm.b64png(to_img(blurred))}
    bodies["lora"] = bodies["padref-free"] | {"prompt": lex.OUTPAINT_PROMPT + (f" {prompt}" if prompt else ""), "lora": [{"path": OUTPAINT_LORA, "multiplier": 1.0}]}
    for v, body in bodies.items():
        if run.variants and v not in run.variants:
            continue
        if v == "lora" and not (cfm.LORA_DIR / OUTPAINT_LORA).is_file():
            print("skipping lora: run lora-inspect.py --split first")
            continue
        raw_p, secs = run.gen(f"out-{cid}-{v}", body, seed)
        fin = run.out / "raw" / f"out-{cid}-{v}-final.png"
        edit_lab("finish", d, raw_p, fin)
        final = Image.open(fin).convert("RGB")
        full = raw_full(raw_p)
        free = "mask_image" not in body
        run.record("outpaint", cid, v, final, secs, body["prompt"], **metrics(final, full if free else None))
        if run.fix:
            edit_lab("finish", d, raw_p, fin.with_name(fin.stem + "-nomatch.png"), "nomatch")
            nm = Image.open(fin.with_name(fin.stem + "-nomatch.png")).convert("RGB")
            run.record("outpaint", cid, v + "-nomatch", nm, None, "(same raw, earlier paste-back)", **metrics(nm))
            continue
        h = harm(full)
        run.record("outpaint", cid, v + "+harm", h, None, "(post only)", **metrics(h))
    src.save(run.out / f"outpaint-{cid}-original.jpg", quality=92)
    to_img(grey).save(run.out / f"outpaint-{cid}-mask.jpg", quality=88)
    (run.out / f"outpaint-{cid}-keep.json").write_text(json.dumps(rf))


# ---------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------


def zooms(out, results):
    """Zoomed crops around the paste border, the same box for every variant of a case."""
    for sec in ("inpaint", "outpaint"):
        for case in dict.fromkeys(x["case"] for x in results if x["section"] == sec):
            if sec == "inpaint":
                m = np.asarray(Image.open(out / "inputs" / f"{case}-mask.png").convert("L")) > 127
                ys, xs = np.nonzero(m)
                if not len(xs):
                    continue
                cx, cy, half = (xs.min() + xs.max()) // 2, (ys.min() + ys.max()) // 2, max(xs.max() - xs.min(), ys.max() - ys.min()) // 2 + 40
            else:
                rf = json.loads((out / f"outpaint-{case}-keep.json").read_text())
                first = Image.open(out / next(x["file"] for x in results if x["case"] == case))
                # The first expanded edge: left, then right, top, bottom.
                if rf["x"] > 0:
                    cx, cy = rf["x"], rf["y"] + rf["height"] // 2
                elif rf["x"] + rf["width"] < first.width:
                    cx, cy = rf["x"] + rf["width"], rf["y"] + rf["height"] // 2
                elif rf["y"] > 0:
                    cx, cy = rf["x"] + rf["width"] // 2, rf["y"]
                else:
                    cx, cy = rf["x"] + rf["width"] // 2, rf["y"] + rf["height"]
                half = max(96, first.height // 6)
            for x in [x for x in results if x["case"] == case] + [{"file": f"{sec}-{case}-original.jpg", "variant": "original"}]:
                if sec == "outpaint" and x["variant"] == "original":
                    continue
                img = Image.open(out / x["file"])
                b = (max(0, cx - half), max(0, cy - half), min(img.width, cx + half), min(img.height, cy + half))
                img.crop(b).resize((384, round(384 * (b[3] - b[1]) / max(1, b[2] - b[0]))), Image.LANCZOS).save(out / "zoom" / f"{sec}-{case}-{x['variant']}.jpg", quality=90)


def report(out, results):
    (out / "zoom").mkdir(exist_ok=True)
    zooms(out, results)
    fmt = lambda x: " · ".join(f"{k} {x[k]}" for k in ("step", "change", "outside", "drift") if x.get(k) is not None)
    parts = []
    for sec in ("inpaint", "outpaint"):
        rows = []
        for case in dict.fromkeys(x["case"] for x in results if x["section"] == sec):
            cs = [x for x in results if x["case"] == case and x["section"] == sec]
            head = f'<th><b>{html.escape(case)}</b><a href="{sec}-{case}-original.jpg"><img src="{sec}-{case}-original.jpg"></a><a href="{sec}-{case}-mask.jpg"><img src="{sec}-{case}-mask.jpg"></a><p>{html.escape(cs[0]["prompt"])}</p></th>'
            tds = "".join(
                f'<td><b>{html.escape(x["variant"])}</b><a href="{x["file"]}"><img src="{x["file"]}" loading=lazy></a>'
                f'<a href="zoom/{sec}-{case}-{x["variant"]}.jpg"><img src="zoom/{sec}-{case}-{x["variant"]}.jpg" loading=lazy></a>'
                f'<div>{x["seconds"] or 0:.0f} s · {fmt(x)}</div></td>'
                for x in cs
            )
            rows.append(f"<tr>{head}{tds}</tr>")
        parts.append(f"<h2>{sec}</h2><table>{''.join(rows)}</table>")
    style = "body{font:13px system-ui;margin:12px}td,th{vertical-align:top;padding:4px;width:260px;text-align:left}img{width:256px;display:block;margin:2px 0}p{font-weight:normal;color:#555}"
    (out / "report.html").write_text(f"<!doctype html><meta charset=utf-8><title>Inpaint explore</title><style>{style}</style><h1>Inpaint / Expand A/B</h1>{''.join(parts)}", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="inpaint or outpaint")
    ap.add_argument("--cases", help="comma-separated case ids")
    ap.add_argument("--full", action="store_true", help="every case and variant instead of the quick set")
    ap.add_argument("--set", choices=["quick", "fix", "wide"], default="quick", help="quick: the 10-run A/B; fix: check the fixes; wide: the fixes on 11 harder cases")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--quality", default="balanced", choices=["fast", "balanced", "quality"])
    ap.add_argument("--out", type=Path)
    ap.add_argument("--no-server", action="store_true", help="use an sd-server already listening on the script's port")
    ap.add_argument("--dry", action="store_true", help="no server: inputs stand in for results (tests the script)")
    a = ap.parse_args()
    out = a.out or Path.home() / "Desktop" / "kokon-inpaint-explore" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    build_edit_lab()
    fix = a.set in ("fix", "wide") and not a.full
    wide = a.set == "wide" and not a.full
    wanted = set(a.cases.split(",")) if a.cases else None if a.full or fix else QUICK_CASES
    proc = None if a.no_server or a.dry else cfm.start_server(out)[0]
    run = Run(out, a.seed, a.quality, a.dry, None if a.full else {"kokon"} if fix else QUICK_VARIANTS, fix)
    t0 = time.time()
    try:
        for sec, cases, fn in (("inpaint", WIDE_INPAINT if wide else FIX_INPAINT if fix else INPAINT, inpaint_case),
                                 ("outpaint", WIDE_OUTPAINT if wide else FIX_OUTPAINT if fix else OUTPAINT, outpaint_case)):
            if a.only and a.only != sec:
                continue
            for c in cases:
                if wanted is None or c[0] in wanted:
                    try:
                        fn(run, c)
                    except Exception as e:  # one failure must not stop a long run
                        print(f"{sec} {c[0]} FAILED: {e!r}")
                        if a.dry:
                            raise
                    report(out, run.results)
    finally:
        if proc:
            proc.kill()
    report(out, run.results)
    print(f"done in {(time.time() - t0) / 60:.1f} min: {out / 'report.html'}")


if __name__ == "__main__":
    main()
