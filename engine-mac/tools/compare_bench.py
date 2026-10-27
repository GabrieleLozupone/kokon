#!/usr/bin/env python3
"""The tables of a Mac engine pull request, from two bench reports of the same Mac: the baseline (master) and the
branch. `bench --out X.md` (and tools/bench.sh) writes X.json next to the report; pass those two files.

    python3 -I tools/compare_bench.py baseline-report.json kokon-bench-report.json > tables.md

Prints markdown: the Mac, then per run (default and each path off) the times, peak memory and accuracy, before and
after, with the change. The velocity error is also given as a ratio to the baseline default's, the number the
review looks at (engine-mac/AGENTS.md: a default path stays in the order of 1e-4). Standard library only.
"""
import json, sys


def load(path):
    with open(path) as f:
        return json.load(f)


def mac(r):
    return (f"{r.get('chip', '?')} ({r.get('model', '?')}), {r.get('gpuCores', '?')} GPU cores (Apple{r.get('gpuFamily', '?')}), "
            f"{r.get('performanceCores', '?')}+{r.get('efficiencyCores', '?')} CPU cores, {r.get('memoryGB', '?')} GB, "
            f"macOS {r.get('macOS', '?')}")


def change(a, b):
    # No verdict mark: one run per side cannot say whether a change is real.
    if a is None or b is None or a == 0:
        return "–"
    return f"{(b - a) / a * 100:+.1f} %"


def fmt(v, f):
    return "–" if v is None else f.format(v)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    base, new = load(sys.argv[1]), load(sys.argv[2])
    out = []
    out.append(f"**Mac:** {mac(new)}")
    if mac(base) != mac(new):
        out.append(f"\n⚠️ The baseline ran on a different Mac or macOS: {mac(base)}. The two reports cannot be compared.")
    if base.get("quick") != new.get("quick"):
        out.append("\n⚠️ One report is --quick and the other is not: image 2 is missing from one side.")
    out.append(f"\nBaseline engine: {base.get('engine', '?')}  \nBranch engine: {new.get('engine', '?')}")
    out.append(f"\nPaths selected on the branch: {'; '.join(new.get('paths', [])) or 'none chip-specific'}")
    if base.get("paths") != new.get("paths"):
        out.append(f"(baseline: {'; '.join(base.get('paths', [])) or 'none chip-specific'})")

    base_runs = {r["name"]: r for r in base.get("runs", [])}
    new_runs = {r["name"]: r for r in new.get("runs", [])}
    default = next(iter(base.get("runs", [])), {})
    ref_error = default.get("velocityError")

    out.append("\n### Speed at 1024² (bench)\n")
    out.append("| Run | Measure | Baseline | Branch | Change |")
    out.append("|---|---|---|---|---|")
    for name, n in new_runs.items():
        b = base_runs.get(name, {})
        for key, label, f in [("image1", "image 1", "{:.1f} s"), ("image2", "image 2", "{:.1f} s"),
                              ("step", "step (2–8)", "{:.2f} s"), ("vae", "VAE", "{:.2f} s"), ("peak", "peak memory", "{:.1f} GB")]:
            if key in n or key in b:
                out.append(f"| {name} | {label} | {fmt(b.get(key), f)} | {fmt(n.get(key), f)} | {change(b.get(key), n.get(key))} |")

    out.append("\n### Accuracy at 512² against the fp32 path (bench)\n")
    out.append("| Run | Velocity error: baseline | branch | × baseline default | Image levels (mean / max): baseline | branch |")
    out.append("|---|---|---|---|---|---|")
    for name, n in new_runs.items():
        b = base_runs.get(name, {})
        e = n.get("velocityError")
        ratio = "–" if e is None or not ref_error else f"{e / ref_error:.2f}×"
        warn = " ⚠️ ≥ 1e-3" if e is not None and e >= 1e-3 else ""

        def levels(r):
            return "–" if r.get("imageMeanLevels") is None else f"{r['imageMeanLevels']:.2f} / {r['imageMaxLevels']}"
        out.append(f"| {name} | {fmt(b.get('velocityError'), '{:.1e}')} | {fmt(e, '{:.1e}')}{warn} | {ratio} | "
                   f"{levels(b)} | {levels(n)} |")

    missing = [name for name in base_runs if name not in new_runs]
    if missing:
        out.append(f"\nRuns only in the baseline: {', '.join(missing)}")
    out.append("\nOne bench run per side: confirm speed changes with tools/ab.sh (alternated rounds) before trusting them.")
    print("\n".join(out))


if __name__ == "__main__":
    main()
