"""Explores what Qwen-Image 2.1 Turbo does well and badly on its own, across domains (photo,
game assets, 3D characters, design, architecture), and what four existing LoRAs add.

Close Kokon first: this starts its own sd-server with the exact flags of Kokon's last launch
(see compare-fast-modes.py) plus `--lora-model-dir`, and sends Kokon's Turbo request (8 steps,
the checkpoint's sigmas, CFG 1, about 1 MP). Every case uses fixed seeds, so the same command
gives the same images.

Sections (all by default):
  limits       Turbo alone: text-to-image and edits in many domains, 2 seeds each
  consistency  ausboss Consistency: edits that should keep the frame (drift in px measured)
  restore      ausboss Restore: degraded copies of our own images (PSNR against the clean one)
  outpaint     ausboss Outpaint v2: grey-padded canvases (change in the kept area measured)
  angles       akhaliq Multiple-Angles v2: new camera angles vs plain-language prompts
  realism      Danrisi photo-look LoRAs (t2i) vs the same style words without LoRA
LoRA sections run without the LoRA, then at 2 weights, on the `.split` copy written by
`lora-inspect.py --split` (the original files lose their fused MLP modules in sd.cpp); the first
cases also run the original file, to show what the dropped modules change.

    python -I scripts/dev/lora-inspect.py --split             # once: writes the .split copies
    python -I scripts/dev/lora-explore.py                     # everything (~170 images)
    python -I scripts/dev/lora-explore.py --only limits --seeds 1
    python -I scripts/dev/lora-explore.py --out <folder of an earlier run>   # resume: skips done images

Writes <out>/report.html, results.json, the images and the server log. Text-to-image results are
reused as inputs for the edits, so later sections need the limits images (made on demand).
"""

import argparse
import base64
import hashlib
import html
import importlib.util
import io
import json
import random
import socket
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("compare_fast_modes", HERE / "compare-fast-modes.py")
cfm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cfm)

# Kokon's Turbo request (planner::TURBO_SIGMAS, pipeline::effective_prompt).
TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0]
RGBA_PREFIX = "This is an RGBA image with transparency."
RGBA_SUFFIX = "The image has alpha channel and the background is transparent."
TRANSPARENCY_WORDS = ["transparent", "transparency", "alpha channel", "rgba", "no background", "without background", "remove the background", "remove background", "cut out", "cutout"]

LORAS = {
    "consistency": "qwen-image-2.1-consistency",
    "restore": "qwen-image-2.1-restore",
    "outpaint": "qwen-image-2.1-outpaint-v2",
    "angles": "qwen-image-2.1-multiple-angles-v2-1500",
}

# ---------------------------------------------------------------------------------------
# Cases. Text-to-image: (id, domain, aspect, prompt). Edits: (id, domain, input id, prompt).
# ---------------------------------------------------------------------------------------

T2I = [
    # Photo (also the inputs of most edits)
    ("portrait_casual", "photo", 3 / 4, "Casual smartphone selfie of a young man with curly hair in a kitchen, natural daylight, slightly messy background"),
    ("portrait_elder", "photo", 3 / 4, "Portrait photo of an elderly woman smiling, wearing a knitted cardigan, garden background, soft daylight"),
    ("product_table", "photo", 1.0, "Photo of a ceramic coffee mug with a hand-painted lemon pattern on a cluttered wooden kitchen table, morning light"),
    ("street", "photo", 3 / 2, "A street in Rome with a red Vespa parked next to a small café, afternoon light, photo"),
    ("room_empty", "architecture", 3 / 2, "An empty living room with white walls, oak floor and a large window, no furniture, real estate photo"),
    ("sketch_house", "architecture", 3 / 2, "Architectural pencil sketch of a modern two-storey house with a flat roof and large windows, on white paper"),
    # Game design
    ("sprite_sheet", "game", 2.0, "Pixel art sprite sheet of a small knight character: 4 frames of a walking animation in a single row, side view, the same character in every frame, retro 16-bit game style, flat background"),
    ("item_icons", "game", 1.0, "Game inventory icon set: a 3x3 grid of fantasy RPG item icons (iron sword, wooden shield, red health potion, blue mana potion, gold coin pouch, leather boots, magic scroll, silver key, emerald ring), consistent hand-painted style, each icon centered in its own dark square slot"),
    ("iso_building", "game", 1.0, "Isometric game asset of a small medieval blacksmith workshop with a smoking chimney, clean edges, isolated on a transparent background"),
    ("texture", "game", 1.0, "Seamless tileable texture of mossy cobblestone pavement, top-down view, even flat lighting"),
    ("ui_menu", "game", 16 / 9, 'Main menu screen of a cozy farming video game with wooden sign buttons that read "PLAY", "OPTIONS" and "QUIT", pastel colors, game UI design'),
    ("concept_char", "game", 2 / 3, "Full-body concept art of a desert nomad character with a long scarf, goggles and a wooden staff, standing in a neutral pose, plain light grey background, game character design"),
    # 3D / characters
    ("turnaround", "3d", 16 / 9, "Character turnaround sheet of a cartoon robot mascot: front view, side view and back view side by side, full body, the same design in all three views, plain white background, 3D render"),
    ("mascot3d", "3d", 1.0, "Stylized 3D render of a cute round robot mascot with big eyes and small antennas, soft clay material, studio lighting, plain background"),
    ("sneaker", "3d", 1.0, "Product photo of a white and orange running sneaker, three-quarter view, plain light grey background"),
    # Design / text
    ("logo", "design", 1.0, 'Flat vector logo of a fox head for a coffee shop called "Volpe Café", orange and dark brown, transparent background'),
    ("poster_it", "design", 2 / 3, 'Poster per una sagra di paese con il titolo "Sagra del Tartufo" e la scritta "Alba, 12-14 ottobre", illustrazione di boschi autunnali'),
    ("infographic", "design", 3 / 4, "Simple infographic explaining the water cycle with four labelled steps: Evaporation, Condensation, Precipitation, Collection, flat design, white background"),
    ("childrens_book", "illustration", 4 / 3, "Children's book illustration of a hedgehog carrying a red umbrella through autumn leaves, soft watercolor"),
]

EDITS = [
    ("packshot", "photo", "product_table", "Place the mug on a pure white seamless background with a soft natural shadow underneath, e-commerce product photo, keep the mug identical"),
    ("cutout", "photo", "product_table", "Remove the background, keep only the mug"),
    ("headshot", "photo", "portrait_casual", "Turn this into a professional headshot: neutral grey studio background, soft studio lighting, dark blazer, keep the face identical"),
    ("relight", "photo", "portrait_casual", "Relight the photo with warm golden-hour sunlight coming from the left, keep everything else identical"),
    ("night", "photo", "street", "Make it night time with the street lamps and the café lights on"),
    ("staging", "architecture", "room_empty", "Furnish this room as a cozy Scandinavian living room with a sofa, a rug, plants and a coffee table, keep the walls, floor and window identical"),
    ("render", "architecture", "sketch_house", "Turn this sketch into a photorealistic architectural render at sunset, keep the exact design"),
    ("sprite_from_concept", "game", "concept_char", "Turn this character into a pixel art game sprite, full body, on a transparent background"),
    ("texture_snow", "game", "texture", "Cover the same texture with a thin layer of snow, keep it seamless and tileable"),
    ("to3d", "3d", "concept_char", "Turn this character into a stylized 3D figurine render, soft clay material, same design and colors"),
    ("expressions", "3d", "mascot3d", "Create an expression sheet of this robot: six different facial expressions in a 3x2 grid, same design"),
    ("colorway", "3d", "sneaker", "Change the sneaker colors to navy blue and lime green, keep the design identical"),
    ("translate", "design", "poster_it", "Translate all the text on the poster to English, keep the design identical"),
    ("mockup", "design", "logo", "Show this logo printed on a white t-shirt worn by a person, product photo"),
    ("watercolor", "illustration", "street", "Turn the photo into a watercolor painting"),
]

CONSISTENCY = [
    ("c_watercolor", "street", "Turn the photo into a watercolor painting"),
    ("c_winter", "street", "Change the season to winter with snow on the ground"),
    ("c_hoodie", "portrait_casual", "Change his shirt to a red hoodie"),
    ("c_comic", "concept_char", "Turn the image into a comic book drawing with bold black outlines"),
    ("c_mug_blue", "product_table", "Change the mug color to dark blue"),
    ("c_turn_head", "portrait_casual", "Make him turn his head to look to his left"),  # movement: known weak spot
]

RESTORE_GENERAL = "Restore the photo: remove blur, noise and compression artifacts and recover sharp, natural detail, keeping the same composition, people and colors."
RESTORE_OLD = "Restore the old photo: remove scratches, dust, fading and grain and recover sharp, natural detail and color, keeping the same composition and people."
RESTORE = [
    # id, source, degradation, prompt
    ("r_lowres", "portrait_elder", "lowres", RESTORE_GENERAL),
    ("r_oldprint", "portrait_elder", "oldprint", RESTORE_OLD),
    ("r_blur", "street", "blur", RESTORE_GENERAL),
    ("r_icons", "item_icons", "lowres", RESTORE_GENERAL),  # an illustration: must not turn into a photo
]

OUTPAINT_PROMPT = "Outpaint the image: replace the solid gray areas with a seamless continuation of the scene, keeping the existing picture unchanged."
OUTPAINT = [
    # id, source, canvas aspect, content box (x, y, w, h) as fractions of the canvas
    ("o_right", "street", 2.2, (0.0, 0.0, 0.68, 1.0)),
    ("o_zoomout", "portrait_elder", 3 / 4, (0.2, 0.2, 0.6, 0.6)),
    ("o_landscape", "concept_char", 16 / 9, (0.3125, 0.0, 0.375, 1.0)),
    ("o_room_left", "room_empty", 2.0, (0.25, 0.0, 0.75, 1.0)),
]

ANGLE_SUBJECTS = ["mascot3d", "sneaker", "concept_char"]
ANGLES = [
    # id, LoRA prompt, plain-language prompt for Turbo alone
    ("back", "<mva> back view, eye-level shot", "Show the same subject from behind (back view), camera at eye level, keep the design identical"),
    ("right", "<mva> right side view, eye-level shot", "Show the same subject from its right side (side profile), camera at eye level, keep the design identical"),
    ("quarter_high", "<mva> front-right quarter view, elevated shot", "Rotate the camera 60 degrees to the right around the subject and raise it slightly, keep the design identical"),
    ("top", "<mva> front view, top-down shot", "Show the same subject from directly above (top-down view), keep the design identical"),
]

# Danrisi's photo-look LoRAs (text-to-image, strength 0.7 per the cards). Each runs against the
# same style words WITHOUT trigger and LoRA, so the column pair shows what the LoRA adds beyond
# the words Turbo already understands.
REALISM_LORAS = [
    # key, file stem, trigger, style words
    ("lenovo", "lenovo_qwen21", "l3n0v0", "amateur photo, shot on cheap mobile phone, high iso, natural light"),
    ("samsung", "samsung_qwen21", "s2msun9", "raw smartphone photo, amateur photo, available light"),
    ("canon", "canon_qwen21", "c2n0n", "dslr photo, amateur photo, candid photo"),
    ("filmstills", "filmstills_qwen21", "", "film still, 35mm film still from a 90s movie"),
    ("grainscape", "grainscape_qwen21", "", "Color film photography, 35mm color negative look, heavy film grain"),
]
REALISM_SUBJECTS = [
    ("chestnuts", 3 / 4, "An old man selling roasted chestnuts at a street stall on a cold evening, steam rising, warm lamp light"),
    ("dinner", 3 / 2, "A family having dinner around a kitchen table, plates of pasta, everyday home scene"),
    ("dog_beach", 3 / 2, "A golden retriever running along the shore of a beach, splashing water"),
    ("ramen", 1.0, "A bowl of ramen on a wooden counter in a small busy restaurant"),
    ("cyclist", 2 / 3, "A woman cycling through a rainy city street with an umbrella, reflections on the asphalt"),
    ("living_room", 3 / 2, "A living room with plants, a worn sofa and books, afternoon sunlight through the window"),
]

# ---------------------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------------------


def effective_prompt(p):
    p = p.strip()
    if any(w in p.lower() for w in TRANSPARENCY_WORDS) and not p.startswith(RGBA_PREFIX):
        return f"{RGBA_PREFIX} {p.rstrip('.')}. {RGBA_SUFFIX}"
    return p


def request(prompt, seed, w, h, refs=(), lora=None):
    body = {
        "prompt": effective_prompt(prompt), "negative_prompt": "", "width": w, "height": h, "seed": seed, "batch_count": 1,
        "sample_params": {"sample_method": "euler", "sample_steps": len(TURBO_SIGMAS) - 1, "custom_sigmas": TURBO_SIGMAS, "guidance": {"txt_cfg": 1.0}},
        "output_format": "png", "embed_image_metadata": False,
    }
    if refs:
        body["ref_images"] = [cfm.b64png(r.convert("RGB").resize((w, h), Image.LANCZOS)) for r in refs]
        body["image_preprocess"] = ["target=ref,mode=none"]
    if lora:
        body["lora"] = [{"path": lora[0], "multiplier": lora[1]}]
    return body


def generate(body):
    """Submit, wait, return (PIL image with alpha if the server sent one, seconds)."""
    t0 = time.perf_counter()
    job = cfm.http("POST", "/sdcpp/v1/img_gen", body)
    while True:
        j = cfm.http("GET", f"/sdcpp/v1/jobs/{job['id']}")
        if j["status"] == "completed":
            img = Image.open(io.BytesIO(base64.b64decode(j["result"]["images"][0]["b64_json"])))
            img.load()
            return img, time.perf_counter() - t0
        if j["status"] in ("failed", "cancelled"):
            raise RuntimeError(json.dumps(j.get("error")))
        time.sleep(0.5)


# ---------------------------------------------------------------------------------------
# Fixtures and metrics
# ---------------------------------------------------------------------------------------


def degrade(img, kind, seed):
    img = img.convert("RGB")
    w, h = img.size
    if kind == "lowres":
        small = img.resize((w // 4, h // 4), Image.BICUBIC)
        buf = io.BytesIO()
        small.save(buf, "JPEG", quality=15)
        return Image.open(buf).convert("RGB").resize((w, h), Image.BICUBIC)
    if kind == "blur":
        return img.filter(ImageFilter.GaussianBlur(3.5))
    if kind == "oldprint":
        rng = random.Random(seed)
        g = ImageOps.grayscale(img.filter(ImageFilter.GaussianBlur(1.6)))
        sep = ImageOps.colorize(g, (60, 40, 20), (235, 215, 175)).convert("RGB")
        a = np.asarray(sep).astype(np.float32)
        a = 70 + a * 0.6  # faded: less contrast, lifted blacks
        a += np.random.default_rng(seed).normal(0, 14, a.shape[:2])[..., None]  # grain
        out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        d = ImageDraw.Draw(out)
        for _ in range(28):  # scratches and dust
            x = rng.randrange(w)
            d.line([(x, rng.randrange(h)), (x + rng.randint(-40, 40), rng.randrange(h))], fill=(245, 240, 225), width=rng.choice([1, 1, 2]))
        for _ in range(140):
            x, y, r = rng.randrange(w), rng.randrange(h), rng.choice([1, 2, 3])
            d.ellipse([x, y, x + r, y + r], fill=rng.choice([(250, 245, 230), (30, 25, 20)]))
        return out
    raise ValueError(kind)


def pad_grey(img, aspect, box, area):
    """`img` fitted into the box (fractions of a ~`area` canvas of `aspect`), grey #808080 elsewhere.
    Returns (canvas, content rect in canvas pixels)."""
    cw, ch = cfm.dims(aspect, area)
    bx, by, bw, bh = int(box[0] * cw), int(box[1] * ch), int(box[2] * cw), int(box[3] * ch)
    src = img.convert("RGB")
    s = min(bw / src.width, bh / src.height)
    nw, nh = round(src.width * s), round(src.height * s)
    x, y = bx + (bw - nw) // 2, by + (bh - nh) // 2
    canvas = Image.new("RGB", (cw, ch), (128, 128, 128))
    canvas.paste(src.resize((nw, nh), Image.LANCZOS), (x, y))
    return canvas, (x, y, nw, nh)


def gray(img, width=512):
    img = img.convert("L")
    return np.asarray(img.resize((width, max(1, round(img.height * width / img.width))), Image.BILINEAR), dtype=np.float32)


def drift_px(a, b):
    """Translation between two images by phase correlation, in pixels of `b`'s width."""
    ga, gb = gray(a), gray(b.resize(a.size, Image.BILINEAR))
    win = np.outer(np.hanning(ga.shape[0]), np.hanning(ga.shape[1]))
    fa, fb = np.fft.fft2((ga - ga.mean()) * win), np.fft.fft2((gb - gb.mean()) * win)
    r = fa * np.conj(fb)
    r = np.fft.ifft2(r / (np.abs(r) + 1e-9)).real
    dy, dx = np.unravel_index(np.argmax(r), r.shape)
    dy = dy - r.shape[0] if dy > r.shape[0] // 2 else dy
    dx = dx - r.shape[1] if dx > r.shape[1] // 2 else dx
    return round(float(np.hypot(dx, dy)) * b.width / ga.shape[1], 1)


def psnr(a, b):
    x = np.asarray(a.convert("RGB").resize((512, 512), Image.BILINEAR), dtype=np.float32)
    y = np.asarray(b.convert("RGB").resize((512, 512), Image.BILINEAR), dtype=np.float32)
    mse = float(((x - y) ** 2).mean())
    return round(10 * np.log10(255 ** 2 / max(mse, 1e-6)), 2)


def kept_change(out, original, rect):
    """Mean absolute difference (0-255) inside the kept area, after rescaling to the canvas."""
    x, y, w, h = rect
    crop = out.convert("RGB").crop((x, y, x + w, y + h)).resize((min(w, 512), round(h * min(w, 512) / w)), Image.BILINEAR)
    ref = original.convert("RGB").resize(crop.size, Image.BILINEAR)
    return round(float(np.abs(np.asarray(crop, np.float32) - np.asarray(ref, np.float32)).mean()), 1)


def alpha_share(img):
    if img.mode != "RGBA":
        return None
    a = np.asarray(img.getchannel("A"))
    share = round(float((a < 128).mean()) * 100, 1)
    return share if share >= 0.5 else None


def tile2x2(img):
    w, h = img.size
    t = Image.new(img.mode, (w * 2, h * 2))
    for dx in (0, w):
        for dy in (0, h):
            t.paste(img, (dx, dy))
    return t.resize((w, h), Image.LANCZOS)


# ---------------------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------------------


class Runner:
    def __init__(self, out, area):
        self.out, self.area = out, area
        self.results = []
        self.images = {}  # t2i id -> PIL (seed index 0), the inputs of edits
        rp = out / "results.json"
        self.done = {r["file"]: r for r in json.loads(rp.read_text(encoding="utf-8"))} if rp.is_file() else {}

    def run(self, section, case, variant, prompt, seed, w, h, refs=(), lora=None, extra=None, label=None, col=None):
        name = f"{section}-{case}-{variant}-s{seed}.png".replace("@", "w")
        path = self.out / name
        rec = {"section": section, "case": case, "variant": variant, "label": label or variant, "prompt": prompt, "seed": seed,
               "lora": lora, "file": name, "width": w, "height": h, "col": col or variant}
        if path.is_file():
            img = Image.open(path)
            img.load()
            old = self.done.get(name, {})
            rec["seconds"] = old.get("seconds")
            rec["cached"] = True
        else:
            try:
                img, secs = generate(request(prompt, seed, w, h, refs, lora))
                img.save(path)
                rec["seconds"] = round(secs, 2)
            except Exception as e:  # keep going: one failure must not stop a long run
                rec["error"] = str(e)[:300]
                print(f"{section:11} {case:20} {variant:22} FAILED {e}")
                self.results.append(rec)
                self.save()
                return None
        if extra:
            rec.update(extra(img))
        a = alpha_share(img)
        if a is not None:
            rec["transparent_pct"] = a
        print(f"{section:11} {case:20} {variant:22} {rec.get('seconds') or 0:6.1f} s {'(cached)' if rec.get('cached') else ''}")
        self.results.append(rec)
        self.save()
        return img

    def save(self):
        (self.out / "results.json").write_text(json.dumps(self.results, indent=1), encoding="utf-8")
        write_report(self.out, self.results)

    def input(self, case_id, seed):
        if case_id not in self.images:
            i = [c[0] for c in T2I].index(case_id)
            _, dom, aspect, prompt = T2I[i]
            w, h = cfm.dims(aspect, self.area)
            img = self.run("limits", case_id, "turbo", prompt, seed + i, w, h, label=dom, col="seed 1")
            if img is None:
                sys.exit(f"could not make the input {case_id}")
            self.images[case_id] = img
        return self.images[case_id]


def lora_variants(key, weights, with_original):
    split = f"{LORAS[key]}.split.safetensors"
    vs = [("none", None)] + [(f"{key}@{w:g}", (split, w)) for w in weights]
    if with_original:
        vs.append((f"{key}-original@1", (f"{LORAS[key]}.safetensors", 1.0)))
    return vs


def main():
    ap = argparse.ArgumentParser()
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    ap.add_argument("--out", default=str(Path.home() / "Desktop" / "kokon-lora-explore" / stamp))
    ap.add_argument("--only", help="comma-separated sections: limits,consistency,restore,outpaint,angles,realism")
    ap.add_argument("--seeds", type=int, default=2, help="seeds per limits case (LoRA sections use 1)")
    ap.add_argument("--seed", type=int, default=4242)
    ap.add_argument("--area", type=int, default=1024 * 1024, help="working pixels (Kokon Fast = 1 MP)")
    a = ap.parse_args()
    sections = a.only.split(",") if a.only else ["limits", "consistency", "restore", "outpaint", "angles", "realism"]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for key in LORAS:
        if key in sections and not (cfm.LORA_DIR / f"{LORAS[key]}.split.safetensors").is_file():
            sys.exit(f"Missing {LORAS[key]}.split.safetensors: run  python -I scripts/dev/lora-inspect.py --split  first.")
    print(f"Output: {out}")
    # A port the OS hands out is outside Windows' reserved ranges (Hyper-V/WSL/Docker reserve
    # blocks that move on every boot; sd-server exits with code 0 when it cannot bind).
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        cfm.PORT = s.getsockname()[1]
    r = Runner(out, a.area)
    proc, caps = cfm.start_server(out)
    try:
        known = {l.get("path") for l in caps.get("loras", [])}
        print("server LoRAs:", sorted(known))
        generate(request("warm-up", 1, 512, 512))

        if "limits" in sections:
            for i, (cid, dom, aspect, prompt) in enumerate(T2I):
                w, h = cfm.dims(aspect, a.area)
                for s in range(a.seeds):
                    img = r.run("limits", cid, "turbo", prompt, a.seed + i + 1000 * s, w, h, label=dom, col=f"seed {s + 1}")
                    if s == 0 and img is not None:
                        r.images[cid] = img
                        if cid == "texture":
                            tile2x2(img).save(out / "limits-texture-tiled.png")
            for i, (eid, dom, src, prompt) in enumerate(EDITS):
                base = r.input(src, a.seed)
                for s in range(a.seeds):
                    img = r.run("limits", eid, "turbo", prompt, a.seed + 500 + i + 1000 * s, *base.size, refs=[base], label=dom, col=f"seed {s + 1}",
                                extra=(lambda im, b=base: {"drift_px": drift_px(b, im)}))
                    if eid == "texture_snow" and s == 0 and img is not None:
                        tile2x2(img).save(out / "limits-texture_snow-tiled.png")

        if "consistency" in sections:
            for i, (cid, src, prompt) in enumerate(CONSISTENCY):
                base = r.input(src, a.seed)
                for v, lora in lora_variants("consistency", [0.75, 1.0], with_original=i < 2):
                    r.run("consistency", cid, v, prompt, a.seed + 2000 + i, *base.size, refs=[base], lora=lora,
                          extra=(lambda im, b=base: {"drift_px": drift_px(b, im)}))

        if "restore" in sections:
            for i, (cid, src, kind, prompt) in enumerate(RESTORE):
                clean = r.input(src, a.seed)
                bad_path = out / f"restore-{cid}-input.png"
                if not bad_path.is_file():
                    degrade(clean, kind, a.seed + i).save(bad_path)
                bad = Image.open(bad_path).convert("RGB")
                for v, lora in lora_variants("restore", [0.5, 1.0], with_original=i < 1):
                    r.run("restore", cid, v, prompt, a.seed + 3000 + i, *bad.size, refs=[bad], lora=lora,
                          extra=(lambda im, c=clean, b=bad: {"psnr_vs_clean": psnr(c, im), "psnr_input": psnr(c, b), "drift_px": drift_px(c, im)}))

        if "outpaint" in sections:
            for i, (cid, src, aspect, box) in enumerate(OUTPAINT):
                base = r.input(src, a.seed)
                canvas, rect = pad_grey(base, aspect, box, a.area)
                canvas.save(out / f"outpaint-{cid}-input.png")
                content = base.convert("RGB")
                for v, lora in lora_variants("outpaint", [0.75, 1.0], with_original=i < 1):
                    r.run("outpaint", cid, v, OUTPAINT_PROMPT, a.seed + 4000 + i, *canvas.size, refs=[canvas], lora=lora,
                          extra=(lambda im, c=content, rc=rect, cv=canvas: {"kept_change": kept_change(im, c, rc), "drift_px": drift_px(cv, im)}))

        if "angles" in sections:
            for si, subj in enumerate(ANGLE_SUBJECTS):
                base = r.input(subj, a.seed)
                for i, (aid, mva, plain) in enumerate(ANGLES):
                    for v, lora in lora_variants("angles", [0.8, 1.0], with_original=si == 0 and i < 2):
                        r.run("angles", f"{subj}-{aid}", v, plain if lora is None else mva, a.seed + 5000 + 10 * si + i, *base.size, refs=[base], lora=lora)
        if "realism" in sections:
            for i, (sid, aspect, subject) in enumerate(REALISM_SUBJECTS):
                w, h = cfm.dims(aspect, a.area)
                seed = a.seed + 6000 + i
                r.run("realism", sid, "plain", subject, seed, w, h)
                for key, stem, trigger, style in REALISM_LORAS:
                    split = f"{stem}.split.safetensors"
                    lora_file = split if (cfm.LORA_DIR / split).is_file() else f"{stem}.safetensors"
                    r.run("realism", sid, f"{key}-words", f"{style}. {subject}", seed, w, h)
                    r.run("realism", sid, f"{key}@0.7", f"{trigger + ', ' if trigger else ''}{style}. {subject}", seed, w, h, lora=(lora_file, 0.7))
    finally:
        proc.terminate()
        proc.wait(timeout=60)
    collect_lora_log(out)
    r.save()
    print(f"\nReport: {out / 'report.html'}")


def collect_lora_log(out):
    log = out / "sd-server-kokon.log"
    if not log.is_file():
        return
    keep = [l.rstrip() for l in log.read_text(encoding="utf-8", errors="replace").splitlines()
            if "LoRA tensors have been applied" in l or "incompatible LoRA tensors" in l or "load lora tensors" in l]
    unused = sum("unused lora tensor" in l for l in log.read_text(encoding="utf-8", errors="replace").splitlines())
    (out / "lora-log.txt").write_text("\n".join(keep + [f"unused lora tensor warnings: {unused}"]), encoding="utf-8")


# ---------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------

METRICS = [("drift_px", "drift {} px"), ("psnr_vs_clean", "PSNR {} dB"), ("psnr_input", "(input {} dB)"), ("kept_change", "kept Δ {}"), ("transparent_pct", "{}% transparent")]


def write_report(out, results):
    sections = {}
    for x in results:
        sections.setdefault(x["section"], {}).setdefault(x["case"], []).append(x)
    parts = []
    for sec, cases in sections.items():
        variants = []
        for cs in cases.values():
            for x in cs:
                key = x["col"]
                if key not in variants:
                    variants.append(key)
        rows = []
        for case, cs in cases.items():
            inp = ""
            for cand in (f"{sec}-{case}-input.png",):
                if (out / cand).is_file():
                    inp = f'<a href="{cand}"><img src="{cand}" loading=lazy></a><div>input</div>'
            tds = []
            for v in variants:
                x = next((x for x in cs if x["col"] == v), None)
                if not x:
                    tds.append("<td></td>")
                elif x.get("error"):
                    tds.append(f"<td class=err>{html.escape(x['error'][:200])}</td>")
                else:
                    m = " · ".join(f.format(x[k]) for k, f in METRICS if x.get(k) is not None)
                    tile = f'<a href="limits-{case}-tiled.png">2×2 tiling</a>' if (out / f"limits-{case}-tiled.png").is_file() and v == variants[0] else ""
                    tds.append(f'<td><a href="{x["file"]}"><img src="{x["file"]}" loading=lazy></a><div>{x.get("seconds") or 0:.1f} s {m} {tile}</div></td>')
            first = cs[0]
            rows.append(f"<tr><th><b>{html.escape(case)}</b> <i>{html.escape(first['label'] if sec == 'limits' else '')}</i><p>{html.escape(first['prompt'])}</p>{inp}</th>{''.join(tds)}</tr>")
        head = "".join(f"<th>{html.escape(v)}</th>" for v in variants)
        times = {}
        for x in results:
            if x["section"] == sec and x.get("seconds") and not x.get("cached"):
                times.setdefault(x["variant"], []).append(x["seconds"])
        tsum = " · ".join(f"{html.escape(v)}: {statistics.median(t):.1f} s" for v, t in times.items())
        parts.append(f"<h2>{html.escape(sec)}</h2><p class=t>median time: {tsum}</p><table><tr><th>case</th>{head}</tr>{''.join(rows)}</table>")
    loglines = (out / "lora-log.txt").read_text(encoding="utf-8") if (out / "lora-log.txt").is_file() else "(written at the end of the run)"
    page = f"""<!doctype html><meta charset=utf-8><title>Kokon LoRA exploration</title>
<style>body{{font:14px system-ui;margin:16px;background:#111;color:#ddd}}table{{border-collapse:collapse;margin-bottom:24px}}
td,th{{border:1px solid #333;padding:6px;vertical-align:top;text-align:left}}
img{{width:260px;display:block;background:repeating-conic-gradient(#555 0 25%,#888 0 50%) 0 0/16px 16px}}
th p{{font-weight:normal;max-width:240px;color:#aaa}}.err{{color:#f77;max-width:260px}}.t{{color:#aaa}}pre{{white-space:pre-wrap;color:#aaa}}</style>
<h1>Qwen-Image 2.1 Turbo: limits and LoRAs</h1>
<p>Turbo Q4_K, 8 steps, CFG 1, ~1 MP, fixed seeds. LoRA columns use the <code>.split</code> files (all modules applied);
<code>-original</code> = the file as published (sd.cpp drops its fused MLP modules). drift = shift against the input (phase correlation);
PSNR = against the clean image before degradation; kept Δ = mean change (0-255) in the area that should stay. Checkerboard = transparent pixels.</p>
{''.join(parts)}<h2>LoRA log</h2><pre>{html.escape(loglines)}</pre>"""
    (out / "report.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main()
