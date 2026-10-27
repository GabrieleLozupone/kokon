# Working on the Mac engine (people and coding agents)

Read this before changing anything in `engine-mac/`. It applies to you and to the agent you work with (Claude Code,
Codex, Cursor…): give it this file. The root [AGENTS.md](../AGENTS.md) still applies; the engine itself is explained in
[docs/mac-engine.md](docs/mac-engine.md) (start with chapters 7, 8, 13, 26–29) and measured in [README.md](README.md).

## The rule in one line

**Make the engine faster on the Mac you develop on, and change nothing on every other Mac.**

The engine was tuned on one M2 Pro (16 GB). Every other chip runs paths that were never measured on it. Your Mac is
the hardware you can measure, so a contribution is an optimization *for that chip*, chosen at run time from
`Chip.current`, with everything else left exactly as it is.

## What a change must look like

1. **Gated by the chip.** Select the new path in `Chip.swift` or where the per-chip paths are chosen (see chapter 26),
   by GPU family, generation, GPU cores or memory: the narrowest condition you measured. Do not widen it to chips you
   have not run ("M4 Max" measured → not "Apple9+").
2. **Behind a switch.** A `KOKON_*` variable that turns it off (and on, to compare). Add it to chapter 32 of the guide.
3. **The current path as its fallback.** When the condition does not hold, or the path cannot run (compile error,
   size it does not cover, memory), the engine takes the existing path. Never a crash, never a silent wrong image.
4. **Listed in `bench`.** Add it to `Bench.swift`'s chip paths, so that its row with the path off appears in every
   report, and others can confirm or refute it on their Macs.
5. **A test that runs on any Mac.** In `Tests/KokonEngineTests/PerChipTests.swift`: the new path's result against the
   existing path's on a small case, forced on even where the chip would not pick it (when it can run there). Plus a
   test of the selection itself (which chip gets it, which does not).
6. **One idea per pull request.** Two optimizations in one PR cannot be measured apart.

Changing a default for *every* chip (a tile size, a share, a memory threshold) is a different kind of change: open an
issue or post in [Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43) first, because it needs
measurements on several Macs.

## What must not break

- **Accuracy.** Measured against the reference, not against itself: `bench`'s accuracy rows (the engine's fp32 path on
  the same Mac) and the `check-*` of the part you changed (fp64 oracle, chapter 28). The default path today is
  ~6–7 · 10⁻⁴ on the velocity and 0.05–0.25 levels mean on the image. **A default path stays in the order of
  10⁻⁴ on the velocity** (below 1 · 10⁻³). Report the new path's error next to the default's, as a ratio. A path that
  reaches 10⁻³ or more stays opt-in, however fast: int8 on the Neural Engine (1.1–4.1 · 10⁻²) is opt-in for that
  reason. A path that multiplies the error for a small gain stays opt-in too: Neural Engine heads were ~1.5 % faster
  for 2.5× the error.
- **Seeds and API.** The same seed gives the same image as before up to that error; `/sdcpp/v1` keeps its requests and
  answers; Prompt+, edits, brushed edits and references still work.
- **Memory.** Peak footprint does not grow on a 16 GB Mac. If your Mac has more memory, say so and do not change what
  happens below it.
- **Everything outside `engine-mac/`.** Windows, Linux, sd.cpp and the app are untouched unless the change needs it;
  if you touch `src/`, `src-tauri/` or `crates/`, run the root tests too.

## The workflow

```bash
git checkout master && git pull
git checkout -b mac-<chip>-<idea>          # e.g. mac-m4max-attention-tiles
cd engine-mac && swift build -c release && swift test

# 1. the baseline, before any change
bash tools/bench.sh                         # ~10 min: rename kokon-bench-report.md/.json to baseline-report.md/.json
bash tools/ab.sh snapshot base

# 2. find where the time goes on this Mac
.build/release/kokon-engine-mac probe
KOKON_PROFILE=1 .build/release/kokon-engine-mac time-dit <dit.gguf> 64 32

# 3. change, build, check
swift build -c release && swift test
.build/release/kokon-engine-mac check-<the part you changed> ...   # chapter 28: check-dit, check-generate, check-na…
bash tools/ab.sh snapshot new

# 4. measure, alternated
bash tools/ab.sh run 3 "base|base|" "new|new|" -- time-dit <dit.gguf> 64 32
bash tools/testset.sh 3 "base|base|" "new|new|"      # the fixed test set, below
bash tools/bench.sh                         # the final report, with the new path's off row
python3 -I tools/compare_bench.py baseline-report.json kokon-bench-report.json   # the PR's bench tables
```

**The fixed test set** (`tools/testset.sh`): the same prompts, sizes and seeds for everyone, so results compare across
branches and Macs. Text to image at 1024², a wide image at 1344×768 (the engine was tuned at 1024² only), and an edit
with a reference. A brushed edit is not in the command line: try one in the app with the branch's engine.

**Before you start, read [chips.md](chips.md)**: what has been measured on each Mac. Add your Mac's row with the PR.

How to measure so the numbers mean something:

- **Alternated, at least 3 rounds, medians**, with the spread (min–max). One run against one run proves nothing: a
  Mac's speed drifts with temperature, other apps and the file cache.
- Plugged in, other apps closed, no `asitop`, no build while it runs. Start the A/B with the Mac cold or warm, the
  same for both arms.
- **A change is kept when its gain shows in every round, beyond the spread between runs.** Small gains count when
  they are that steady: Metal 4 products (7.57 → 7.48 s per evaluation) and the packed attention (~1 %) were kept on
  alternated rounds. A gain inside the spread is not a gain: report it, do not keep it.
- Measure the whole image (`generate` or `bench`), not only the part you changed: a faster product can slow the units
  beside it (chapter 13).
- Nothing tuned on one prompt or one size: every case of the test set, not only the one that got faster.
- **Say which Mac, not only which chip.** A MacBook Air has no fan and slows down when warm: on an Air a "gain" can be
  the heat. There, run fewer rounds with a pause between them (a minute or two) and say so in the report.

## For agents

- **Ask the person before every run that uses the GPU** (`bench`, `ab.sh`, `generate`, `time-dit`, `probe`, `check-*`
  with the model): it takes minutes and the Mac is unusable meanwhile. Give the exact command; run it in the
  background and wait for it to finish, never in a loop of short polls.
- **Never write a number you did not measure.** Every number in the PR comes from a run in this branch, with its
  command. If a run failed or was skipped, the report says so.
- Read the relevant chapter of [docs/mac-engine.md](docs/mac-engine.md) and **chapter 29 (Tried and not kept)** before
  proposing an idea: many have been measured and dropped.
- Keep the code like the code around it: Swift, comments that say *why* and on what it was measured
  ("M4 Max 40-core, 64 GB, macOS 27, ab.sh 3 rounds: 7.1 → 6.6 s per evaluation").
- `bench` writes a `.json` next to its report: build the PR's bench tables with `tools/compare_bench.py`, never by
  copying numbers by hand. The `ab.sh` lines are pasted as they printed.
- A negative result is a valid PR: add it to chapter 29 and to the README's notes, with its numbers, and change no code.

## The pull request report

Paste this in the PR description, filled in. Attach both bench reports, `.md` and `.json` (or paste them in a
collapsed `<details>` block). The "Mac engine" check (GitHub Actions) builds the engine and runs `swift test` on every
PR that touches `engine-mac/`; it runs in a virtual Mac, so your own `swift test` still counts.

```markdown
## Mac engine: <what, in one line>

**Mac:** <chip, GPU cores, CPU cores, memory, macOS, model (MacBook Air / Pro, mini, Studio…): fan or not>  ·  **Branch:** <name>  ·  **Base:** master @ <commit>

### Idea
<Where the time went on this Mac (profile, probe), what the change does, why it should help this chip.>

### Scope
- Chosen when: <the exact condition in Chip / the selection code>
- Switch: `KOKON_<NAME>` (<default on this chip>, `0` off)
- Other chips: unchanged (<how you know: the condition, the selection test>)
- Fallback: <what runs when it does not apply or fails>

### Correctness
| Check | Before | After |
|---|---|---|
| `swift test` | pass | pass (+ <new tests>) |
| `check-<...>` | | |
| bench: velocity error, 512² | | (× the default) |
| bench: image, mean / max levels | | |

### Speed: the test set (alternated, <n> rounds, median and min–max)
| Case | base | new | change |
|---|---|---|---|
| `time-dit` per evaluation | | | |
| 1. text to image 1024² | | | |
| 2. wide 1344×768 | | | |
| 3. edit with a reference | | | |
| peak footprint | | | |
| brushed edit in the app | | | works / not tried |

<details><summary>ab.sh and testset.sh output</summary>

    <pasted as printed>
</details>

### Bench (tools/compare_bench.py)
<its output>

### Not done / risks
<What you did not measure (edits, other sizes, memory sizes), what could behave differently on other chips,
anything you tried and dropped.>

### Docs
- [ ] docs/mac-engine.md chapter 26 (per-chip paths) and 32 (switches)
- [ ] README.md "Per-chip paths" with the numbers
- [ ] chapter 29 for what was tried and not kept
- [ ] chips.md: your Mac's row
```

The maintainer reruns `bench` on the M2 Pro before merging, to confirm nothing changed there.
