"""Checks LoRA files against Kokon's diffusion model without loading either (headers only).

For each .safetensors LoRA it reports the key format, how many modules match a tensor of the
GGUF model (by name and shape), the rank, where the alpha lives and the strength sd.cpp will
actually apply. sd.cpp reads alpha from `.alpha` tensors (and, on newer engines, top-level
metadata), but not from PEFT's `lora_adapter_metadata` JSON: a LoRA whose alpha only lives
there and differs from its rank runs at the wrong strength unless the multiplier compensates.

    python -I scripts/dev/lora-inspect.py                      # every LoRA in Kokon's folder
    python -I scripts/dev/lora-inspect.py path/to/a.safetensors --model path/to/model.gguf
"""

import argparse
import json
import os
import re
import struct
import sys
from collections import Counter
from pathlib import Path

LOCAL = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "KokonData"
LORA_DIR = LOCAL / "sdcpp" / "models" / "loras"
MODEL = LOCAL / "sdcpp" / "models" / "qwen21" / "qwen-image-2.1-turbo-Q4_K.gguf"

# ---------------------------------------------------------------------------------------
# File headers
# ---------------------------------------------------------------------------------------


def safetensors_header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
        base = 8 + n
        meta = header.pop("__metadata__", {}) or {}
        # Scalar `.alpha` tensors: read their values (a few bytes each).
        alphas = {}
        for k, v in header.items():
            if k.endswith(".alpha"):
                f.seek(base + v["data_offsets"][0])
                raw = f.read(v["data_offsets"][1] - v["data_offsets"][0])
                fmt = {"F32": "<f", "F16": "<e", "BF16": None, "F64": "<d"}[v["dtype"]]
                alphas[k] = struct.unpack(fmt, raw[: struct.calcsize(fmt)])[0] if fmt else struct.unpack("<f", b"\0\0" + raw[:2])[0]
    return header, meta, alphas


def gguf_tensors(path):
    """name -> shape (diffusers order, i.e. reversed GGUF dims) of every tensor in a GGUF file."""
    with open(path, "rb") as f:
        if f.read(4) != b"GGUF":
            sys.exit(f"{path} is not a GGUF file")
        version, n_tensors, n_kv = struct.unpack("<IQQ", f.read(20))

        def string():
            (n,) = struct.unpack("<Q", f.read(8))
            return f.read(n).decode("utf-8", "replace")

        sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}

        def skip(t):
            if t == 8:
                string()
            elif t == 9:
                et, n = struct.unpack("<IQ", f.read(12))
                for _ in range(n):
                    skip(et)
            else:
                f.read(sizes[t])

        for _ in range(n_kv):
            string()
            skip(struct.unpack("<I", f.read(4))[0])
        out = {}
        for _ in range(n_tensors):
            name = string()
            (nd,) = struct.unpack("<I", f.read(4))
            dims = struct.unpack(f"<{nd}Q", f.read(8 * nd))
            f.read(12)  # type + offset
            out[name.removeprefix("model.diffusion_model.")] = tuple(reversed(dims))
    return out


# ---------------------------------------------------------------------------------------
# Key formats
# ---------------------------------------------------------------------------------------

PREFIXES = ["base_model.model.", "model.diffusion_model.", "diffusion_model.", "transformer.", "unet."]
SUFFIXES = {
    ".lora_A.default.weight": "down", ".lora_B.default.weight": "up",
    ".lora_A.weight": "down", ".lora_B.weight": "up",
    ".lora_down.weight": "down", ".lora_up.weight": "up",
    ".alpha": "alpha", ".dora_scale": "dora", ".lora_magnitude_vector": "dora",
    ".diff": "diff", ".diff_b": "diff_b",
}


def split_key(k):
    for s, role in SUFFIXES.items():
        if k.endswith(s):
            return k[: -len(s)], role, s
    return k, "other", ""


def detect_format(keys):
    if any(k.startswith(("lora_unet_", "lora_te")) for k in keys):
        return "kohya (partial in sd.cpp: loses gate_layer and root modules)"
    if any(".lora_A." in k or ".lora_B." in k for k in keys):
        pre = Counter(next((p for p in PREFIXES if k.startswith(p)), "(none)") for k in keys)
        return f"PEFT/diffusers, prefix {', '.join(p for p, _ in pre.most_common())}"
    if any(".lora_down." in k for k in keys):
        pre = Counter(next((p for p in PREFIXES if k.startswith(p)), "(none)") for k in keys)
        return f"lora_down/up, prefix {', '.join(p for p, _ in pre.most_common())}"
    if any("lokr_" in k or "hada_" in k for k in keys):
        return "LyCORIS (LoKr/LoHa)"
    return "unknown"


def module_name(base):
    for p in PREFIXES:
        if base.startswith(p):
            return base[len(p):]
    return base


def inspect(path, model):
    header, meta, alphas = safetensors_header(path)
    keys = list(header)
    fmt = detect_format(keys)
    modules = {}
    roles = Counter()
    for k, v in header.items():
        base, role, _ = split_key(k)
        roles[role] += 1
        m = modules.setdefault(module_name(base), {})
        m[role] = v["shape"]
    # Match each module that has a down/up pair against the model tensor `<module>.weight`.
    matched, missing, shape_bad, fused, ranks = [], [], [], [], Counter()
    for name, parts in modules.items():
        if "down" not in parts or "up" not in parts:
            continue
        down, up = parts["down"], parts["up"]
        rank = down[0]
        ranks[rank] += 1
        target = model.get(name + ".weight")
        if target is None and name.endswith(".img_mlp.gate_up") and name.replace("gate_up", "gate_layer") + ".weight" in model:
            # Fused gate+up LoRA on a model with separate gate_layer/proj: sd.cpp only maps the
            # opposite direction, so these are dropped unless the file is split (--split).
            fused.append(name)
        elif target is None:
            missing.append(name)
        elif (up[0], down[1]) != tuple(target[:2]):
            shape_bad.append(f"{name}: lora {up[0]}x{down[1]} vs model {target}")
        else:
            matched.append(name)
    pairs = len(matched) + len(missing) + len(shape_bad) + len(fused)
    # Alpha: tensors, top-level metadata, PEFT JSON.
    peft = {}
    if "lora_adapter_metadata" in meta:
        try:
            peft = json.loads(meta["lora_adapter_metadata"])
        except ValueError:
            pass
    rank = ranks.most_common(1)[0][0] if ranks else None
    alpha_t = sorted(set(round(a, 4) for a in alphas.values()))
    alpha_meta = meta.get("alpha") or meta.get("ss_network_alpha")
    alpha_peft = peft.get("lora_alpha")
    if alpha_t:
        src, alpha = ".alpha tensors (read by sd.cpp)", alpha_t[0]
        engine_scale = alpha / rank if rank else None
    elif alpha_meta:
        src, alpha = "top-level metadata (read only by engines with metadata-alpha)", float(alpha_meta)
        engine_scale = None
    elif alpha_peft:
        src, alpha = "PEFT lora_adapter_metadata only (NOT read by sd.cpp)", float(alpha_peft)
        engine_scale = 1.0
    else:
        src, alpha, engine_scale = "none (scale 1)", None, 1.0
    intended = alpha / rank if (alpha and rank) else 1.0
    if engine_scale is None:
        correction = f"x{intended:g} if the engine ignores metadata alpha, else 1"
    else:
        correction = f"x{intended / engine_scale:g}" if engine_scale else "?"
    return {
        "file": Path(path).name,
        "size_mb": round(Path(path).stat().st_size / 1e6, 1),
        "format": fmt,
        "tensors": len(keys),
        "roles": dict(roles),
        "modules_with_pairs": pairs,
        "matched": len(matched),
        "fused_gate_up": len(fused),
        "missing_in_model": missing[:8] + (["…"] if len(missing) > 8 else []),
        "shape_mismatch": shape_bad[:5] + (["…"] if len(shape_bad) > 5 else []),
        "ranks": dict(ranks),
        "alpha": alpha,
        "alpha_source": src,
        "intended_scale": round(intended, 4),
        "multiplier_correction": correction,
        "targets": sorted({re.sub(r"transformer_blocks\.\d+\.", "", m) for m in matched}),
        "metadata_keys": sorted(meta)[:20],
    }


def split_gate_up(path, dest):
    """Writes a copy of a LoRA with each fused `img_mlp.gate_up` pair split into `gate_layer`
    (first half of the output rows) and `proj` (second half), the order sd.cpp's fused layer
    uses. The down matrix is shared by both halves. Everything else is copied byte for byte."""
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
        data = f.read()
    meta = header.pop("__metadata__", None)
    tensors = {}
    for k, v in header.items():
        a, b = v["data_offsets"]
        tensors[k] = (v["dtype"], v["shape"], data[a:b])
    out = {}
    for k, (dtype, shape, raw) in tensors.items():
        if ".img_mlp.gate_up." not in k:
            out[k] = (dtype, shape, raw)
            continue
        base, role, suffix = split_key(k)
        gate, proj = base.replace("gate_up", "gate_layer"), base.replace("gate_up", "proj")
        if role == "up":
            half = shape[0] // 2
            row = len(raw) // shape[0]
            out[gate + suffix] = (dtype, [half, *shape[1:]], raw[: half * row])
            out[proj + suffix] = (dtype, [shape[0] - half, *shape[1:]], raw[half * row:])
        else:  # down / alpha: shared by both halves
            out[gate + suffix] = (dtype, shape, raw)
            out[proj + suffix] = (dtype, shape, raw)
    head, blob, off = {}, bytearray(), 0
    if meta:
        head["__metadata__"] = meta
    for k, (dtype, shape, raw) in out.items():
        head[k] = {"dtype": dtype, "shape": shape, "data_offsets": [off, off + len(raw)]}
        blob += raw
        off += len(raw)
    hj = json.dumps(head, separators=(",", ":")).encode()
    hj += b" " * (-len(hj) % 8)
    tmp = Path(str(dest) + ".part")
    with open(tmp, "wb") as f:
        f.write(struct.pack("<Q", len(hj)) + hj + blob)
    tmp.replace(dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", action="store_true", help="write <name>.split.safetensors next to every LoRA with fused gate_up modules")
    ap.add_argument("files", nargs="*", help="LoRA files (default: every .safetensors in Kokon's LoRA folder)")
    ap.add_argument("--model", default=str(MODEL), help="the GGUF diffusion model to match against")
    ap.add_argument("--json", action="store_true", help="print JSON instead of text")
    a = ap.parse_args()
    files = [Path(f) for f in a.files] or sorted(LORA_DIR.glob("*.safetensors"))
    if a.split:
        model = gguf_tensors(a.model)
        for f in files:
            if f.name.endswith(".split.safetensors"):
                continue
            if inspect(f, model)["fused_gate_up"]:
                dest = f.with_name(f.name.removesuffix(".safetensors") + ".split.safetensors")
                if dest.exists():
                    print(f"exists: {dest.name}")
                else:
                    split_gate_up(f, dest)
                    print(f"wrote {dest.name}")
        splits = [f.with_name(f.name.removesuffix(".safetensors") + ".split.safetensors") for f in files]
        files = sorted({*files, *(s for s in splits if s.is_file())})
    if not files:
        sys.exit(f"No LoRA files in {LORA_DIR}")
    model = gguf_tensors(a.model)
    reports = [inspect(f, model) for f in files]
    if a.json:
        print(json.dumps(reports, indent=1))
        return
    print(f"Model: {Path(a.model).name} ({len(model)} tensors)\n")
    for r in reports:
        ok = r["matched"] == r["modules_with_pairs"] and r["matched"] > 0
        print(f"{'OK ' if ok else '!! '} {r['file']}  ({r['size_mb']} MB)")
        print(f"    format: {r['format']}; {r['tensors']} tensors {r['roles']}")
        print(f"    modules matched: {r['matched']}/{r['modules_with_pairs']}; ranks {r['ranks']}")
        if r["fused_gate_up"]:
            print(f"    fused img_mlp.gate_up: {r['fused_gate_up']} modules DROPPED by sd.cpp on this model (use --split)")
        if r["missing_in_model"]:
            print(f"    not in the model: {r['missing_in_model']}")
        if r["shape_mismatch"]:
            print(f"    shape mismatch: {r['shape_mismatch']}")
        print(f"    targets: {', '.join(r['targets'])}")
        print(f"    alpha: {r['alpha']} from {r['alpha_source']}; intended scale {r['intended_scale']}; multiplier {r['multiplier_correction']}")
        print()


if __name__ == "__main__":
    main()
