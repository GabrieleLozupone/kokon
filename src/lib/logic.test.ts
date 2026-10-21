import { describe, expect, it } from "vitest";
import {
  activeLoras, activeOverrides, buildRequest, toggleLora, MAX_LORAS, jobPercent, compareBase, composerFromRecord, enhancerApplies, diffPixels, emptyComposer, expansionPixels, expansionPreset, jobLabel, jobSecondsLeft, lutInfo, moveRef, needsPrompt, normalizeQuality, persistentAdvanced, pipelineSummary,
  planPipeline, remainingSeconds, sizeForWidth, timeAgo, upscaleRequest, upscaleTargets, versionLabels, type JobClock, type Ref,
  neighbourAfterRemoval, previewIndex, starPromptDue, STAR_PROMPT_AFTER, formatBytes, formatDuration, installItemShort, installItemText, installProgress, installStep, installTimeLeft, timelineLinks, undoTarget, aspectLabel, parseRatio, sizeForRatio, expandToRatio, expandToSize, arcLayout,
} from "./logic";
import type { GenerationRecord, InstallItem, JobView, LoraItem, Plan } from "./types";

const ref = (n: number): Ref => ({ key: `k${n}`, source: `input:${n}`, width: 100, height: 100, name: `r${n}` });

describe("references", () => {
  it("moves while preserving order of others", () => {
    const refs = [ref(1), ref(2), ref(3)];
    expect(moveRef(refs, 2, 0).map((r) => r.key)).toEqual(["k3", "k1", "k2"]);
    expect(moveRef(refs, 0, 2).map((r) => r.key)).toEqual(["k2", "k3", "k1"]);
    expect(moveRef(refs, 1, 1)).toBe(refs);
  });
});

describe("advanced overrides", () => {
  // What an older version saved after a CFG test (found in a real WebView profile).
  const saved = { batch_count: null, cfg: 4, flow_shift: null, hdr: false, output_format: "png" as const, refine: null, sampler: null, scheduler: null, steps: 20, strength: 1, vae_tiling: null };

  it("lists only the sampling overrides that are set", () => {
    // Steps, CFG and scheduler are fixed by Turbo: old values are dropped, never shown.
    expect(activeOverrides(saved)).toEqual(["Strength 1"]);
    expect(activeOverrides({ sampler: "heun" })).toEqual(["Sampler heun"]);
    expect(activeOverrides({ output_format: "webp", hdr: true, batch_count: 2 })).toEqual([]);
    expect(activeOverrides({})).toEqual([]);
    expect(activeOverrides({ reference_detail: "full" })).toEqual(["Reference full"]);
    expect(persistentAdvanced({ reference_detail: "full", output_format: "webp" })).toEqual({ output_format: "webp" });
    // Every new chat starts at the standard 1 MP reference, other settings carry over.
    expect(emptyComposer({ advanced: { reference_detail: "full", batch_count: 2 } }).advanced).toEqual({ batch_count: 2 });
  });

  it("keeps preferences but never persists sampling overrides", () => {
    expect(persistentAdvanced(saved)).toEqual({ hdr: false, output_format: "png" });
    expect(persistentAdvanced(undefined)).toEqual({});
    expect((emptyComposer({ advanced: persistentAdvanced(saved) }).advanced as Record<string, unknown>).cfg).toBeUndefined();
  });
});

describe("normalizeQuality", () => {
  it("maps older preset names", () => {
    expect(emptyComposer().quality).toBe("fast");
    expect(normalizeQuality("turbo")).toBe("fast");
    expect(normalizeQuality("ultra")).toBe("quality");
    expect(normalizeQuality("balanced")).toBe("balanced");
    expect(normalizeQuality(undefined, "quality")).toBe("quality");
    expect(emptyComposer({ quality: "turbo" as never }).quality).toBe("fast");
  });
});

describe("buildRequest", () => {
  it("text to image uses aspect, no images", () => {
    const c = { ...emptyComposer(), prompt: " a fox ", aspect: "16:9" };
    const r = buildRequest(c);
    expect(r.prompt).toBe("a fox");
    expect(r.images).toEqual([]);
    expect(r.aspect_ratio).toBe("16:9");
    expect(r.width).toBeNull();
  });
  it("keeps reference order and the chosen aspect for edits and combines", () => {
    const c = { ...emptyComposer(), prompt: "combine", refs: [ref(3), ref(1), ref(2)], aspect: "16:9" };
    const r = buildRequest(c);
    expect(r.images).toEqual(["input:3", "input:1", "input:2"]);
    expect(r.aspect_ratio).toBe("16:9");
  });
  it("inpaint and expand ignore the aspect", () => {
    const masked = { ...emptyComposer(), prompt: "x", refs: [ref(1)], mask: { inputId: "m", refKey: "k1" }, aspect: "16:9" };
    expect(buildRequest(masked).aspect_ratio).toBeNull();
    const expanded = { ...emptyComposer(), prompt: "x", refs: [ref(1)], outpaint: { left: 10, right: 10, top: 0, bottom: 0, units: "percent" as const }, aspect: "16:9" };
    expect(buildRequest(expanded).aspect_ratio).toBeNull();
  });
  it("mask only applies to the image it was painted on", () => {
    const c = { ...emptyComposer(), prompt: "x", refs: [ref(1)], mask: { inputId: "m", refKey: "k1" } };
    expect(buildRequest(c).mask).toBe("input:m");
    const moved = { ...c, refs: [ref(2), ref(1)] };
    expect(buildRequest(moved).mask).toBeNull();
  });
  it("sends the inpaint action with a valid mask only; removal needs no prompt", () => {
    const c = { ...emptyComposer(), prompt: "", refs: [ref(1)], mask: { inputId: "m", refKey: "k1" }, inpaintAction: "remove" as const };
    expect(buildRequest(c).inpaint_action).toBe("remove");
    expect(needsPrompt(c)).toBe(false);
    expect(needsPrompt({ ...c, inpaintAction: "add" })).toBe(true);
    const moved = { ...c, refs: [ref(2), ref(1)] };
    expect("inpaint_action" in buildRequest(moved)).toBe(false);
    expect(needsPrompt(moved)).toBe(true);
  });
  it("custom resolution sends dimensions", () => {
    const c = { ...emptyComposer(), prompt: "x", resolution: "custom" as const, customWidth: 1280, customHeight: 720 };
    const r = buildRequest(c);
    expect([r.width, r.height]).toEqual([1280, 720]);
  });
  it("forced Create mode ignores attached images", () => {
    const c = { ...emptyComposer(), prompt: "x", refs: [ref(1)], mode: "generate" as const };
    expect(buildRequest(c).images).toEqual([]);
  });
  it("prompt enhancer: off by default, remembered, only for new images, edits and combines", () => {
    expect(emptyComposer().enhance).toBe(false);
    expect(emptyComposer({ enhance: true }).enhance).toBe(true);
    const off = { ...emptyComposer(), prompt: "un gatto" };
    expect("enhance" in buildRequest(off)).toBe(false);
    const on = { ...off, enhance: true };
    expect(buildRequest(on).enhance).toBe(true);
    expect(buildRequest({ ...on, refs: [ref(1), ref(2)] }).enhance).toBe(true);
    const masked = { ...on, refs: [ref(1)], mask: { inputId: "m", refKey: "k1" } };
    expect(enhancerApplies(masked)).toBe(false);
    expect("enhance" in buildRequest(masked)).toBe(false);
    const expanded = { ...on, refs: [ref(1)], outpaint: { left: 10, right: 0, top: 0, bottom: 0, units: "percent" as const } };
    expect("enhance" in buildRequest(expanded)).toBe(false);
  });
  it("reusing an enhanced result's settings gives the user's prompt with the enhancer on", () => {
    const g = { prompt: "A tabby cat sleeping on a sunlit windowsill.", original_prompt: "un gatto", references: [], mask_input_id: null, outpaint: null, quality: "fast", request: null } as unknown as GenerationRecord;
    const c = composerFromRecord(g, emptyComposer());
    expect([c.prompt, c.enhance]).toEqual(["un gatto", true]);
    const plain = composerFromRecord({ ...g, original_prompt: null }, { ...emptyComposer(), enhance: true });
    expect([plain.prompt, plain.enhance]).toEqual(["A tabby cat sleeping on a sunlit windowsill.", false]);
  });
});

describe("LoRA", () => {
  const l = (id: string, onByDefault = false, available = true) => ({ id, name: id, onByDefault, available, weight: 1 }) as LoraItem;
  const all = [l("film", true), l("angles"), l("gone", true, false), l("a"), l("b")];
  it("a new project uses the ones on by default that are still there", () => {
    expect(activeLoras({ loras: null }, all)).toEqual(["film"]);
    expect(activeLoras({ loras: [] }, all)).toEqual([]);
    expect(activeLoras({ loras: ["angles", "removed", "gone"] }, all)).toEqual(["angles"]);
  });
  it("switches one on or off, at most MAX_LORAS", () => {
    expect(toggleLora({ loras: null }, all, "film")).toEqual([]);
    expect(toggleLora({ loras: null }, all, "angles")).toEqual(["film", "angles"]);
    const full = ["film", "angles", "a"];
    expect(full.length).toBe(MAX_LORAS);
    expect(toggleLora({ loras: full }, all, "b")).toEqual(full);
  });
  it("reusing settings brings back the LoRAs the image was made with", () => {
    const g = { prompt: "x", references: [], mask_input_id: null, outpaint: null, quality: "fast", request: null, loras: [{ id: "film", name: "Film", weight: 0.7 }] } as unknown as GenerationRecord;
    expect(composerFromRecord(g, emptyComposer()).loras).toEqual(["film"]);
    expect(composerFromRecord({ ...g, loras: undefined }, { ...emptyComposer(), loras: ["a"] }).loras).toEqual([]);
  });
});

describe("expansion", () => {
  const zero = { left: 0, right: 0, top: 0, bottom: 0, units: "pixels" as const };
  it("presets", () => {
    expect(expansionPreset("right", 1000, 800, zero)).toMatchObject({ right: 250 });
    const l = expansionPreset("landscape", 1024, 1024, zero);
    expect(l.left + l.right + 1024).toBe(1820);
    const s = expansionPreset("square", 1920, 1080, zero);
    expect(s.top + s.bottom + 1080).toBe(1920);
  });
  it("percent to pixels", () => {
    expect(expansionPixels({ left: 10, right: 0, top: 50, bottom: 0, units: "percent" }, 1000, 600)).toEqual({ left: 100, right: 0, top: 300, bottom: 0 });
  });
});

describe("job labels are truthful", () => {
  const base: JobView = {
    id: "j", status: "running", stage: "generating", step: [12, 30], image: null, seconds_per_step: 2, queue_position: 0, created_at: "",
    started_at: null, finished_at: null, prompt: "", plan: null, seed: 1, results: [], error: null, notes: [], detailed_progress: true,
  };
  it("shows steps and tiles only when reported", () => {
    expect(jobLabel(base)).toBe("Generating · 12/30");
    expect(jobLabel({ ...base, step: null })).toBe("Generating");
    expect(jobLabel({ ...base, status: "queued", queue_position: 3 })).toBe("Queued · 3");
    expect(jobLabel({ ...base, status: "enhancing_prompt", stage: null, step: null })).toBe("Writing the prompt");
    expect(jobLabel({ ...base, stage: "upscaling", step: null })).toBe("Upscaling");
    expect(jobLabel({ ...base, stage: "upscaling", step: [2, 6], image: [1, 2] })).toBe("Upscaling · 2/6 · 1/2");
  });
});

describe("one percentage for the whole job", () => {
  // 20 s planned: 15 s to generate, 5 s of upscaler; 8 steps at 1.5 s; the model loads in 10 s.
  const plan = { mode: "generate", estimated_seconds: 20, upscale_share: 0.25, batch_count: 1 } as Plan;
  const job = (o: Partial<JobView>): JobView => ({
    id: "j", status: "running", stage: null, step: null, image: null, seconds_per_step: null, queue_position: 0, created_at: "",
    started_at: null, finished_at: null, prompt: "", plan, seed: 1, results: [], error: null, notes: [], detailed_progress: true, ...o,
  });
  const clock = (o: Partial<JobClock>): JobClock => ({ elapsed: 0, inPhase: 0, inRunning: 0, sinceStep: 0, enhance: false, loadSeconds: 10, enhancerSecondsPerWord: 0.015, ...o });

  it("counts every phase still to come", () => {
    // Loading: the rest of the load, then generation, upscaler and saving.
    expect(jobSecondsLeft(job({ status: "starting_backend" }), clock({ inPhase: 4 }))).toBeCloseTo(6 + 15 + 5 + 1);
    // With the enhancer on, its time too.
    expect(jobSecondsLeft(job({ status: "preparing" }), clock({ enhance: true }))).toBeCloseTo(0.5 + (0.5 + 110 * 0.015) + 21);
    // Sampling: the steps left at the measured pace, decoding, upscaler, saving.
    expect(jobSecondsLeft(job({ stage: "generating", step: [4, 8], seconds_per_step: 1.5 }), clock({}))).toBeCloseTo(4 * 1.5 + 1.5 + 5 + 1);
    // Upscaling: the tiles left at the measured pace, then saving.
    expect(jobSecondsLeft(job({ stage: "upscaling", step: [1, 3], seconds_per_step: 1.5 }), clock({}))).toBeCloseTo(2 * 1.5 + 1);
    // The enhancer's own pace once it writes: 20 words in 1 s, ~110 asked.
    const writing = job({ status: "enhancing_prompt", enhanced_prompt: Array(20).fill("word").join(" ") });
    expect(jobSecondsLeft(writing, clock({ inPhase: 1, enhance: true }))).toBeCloseTo(90 / 20 + 21);
  });

  it("moves with time, forms the logo only after the upscaler, and reaches 100 only when done", () => {
    // Accurate estimates: the percentage is the share of the time spent.
    const loading = jobPercent(job({ status: "starting_backend" }), clock({ elapsed: 5, inPhase: 5 }));
    expect(loading).toBeCloseTo((100 * 5) / 31, 0);
    const halfSteps = jobPercent(job({ stage: "generating", step: [4, 8], seconds_per_step: 1.5 }), clock({ elapsed: 10 + 7, inRunning: 7 }));
    expect(halfSteps).toBeGreaterThan(loading);
    // Generation done, upscaler not started: well short of the logo (92 %).
    const decoded = jobPercent(job({ stage: "upscaling", step: [0, 3] }), clock({ elapsed: 25 }));
    expect(decoded).toBeLessThan(85);
    const lastTile = jobPercent(job({ stage: "upscaling", step: [3, 3], seconds_per_step: 1.6 }), clock({ elapsed: 30 }));
    expect(lastTile).toBeGreaterThan(92);
    expect(jobPercent(job({ status: "saving" }), clock({ elapsed: 31, inPhase: 9 }))).toBeLessThanOrEqual(99);
    expect(jobPercent(job({ status: "done" }), clock({ elapsed: 31 }))).toBe(100);
    expect(jobPercent(job({ status: "queued" }), clock({}))).toBe(0);
  });

  it("an overrun slows the bar instead of stopping it", () => {
    const a = jobPercent(job({ status: "starting_backend" }), clock({ elapsed: 30, inPhase: 30 }));
    const b = jobPercent(job({ status: "starting_backend" }), clock({ elapsed: 60, inPhase: 60 }));
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(99);
  });

  it("an upscale is all upscaler, and an unmeasured machine still gets a curve", () => {
    const quick = { mode: "upscale", estimated_seconds: 8, upscale_share: 0.8, batch_count: 1 } as Plan;
    expect(jobSecondsLeft(job({ plan: quick, stage: "upscaling", step: [0, 4] }), clock({}))).toBeCloseTo(8 + 1);
    const unknown = { ...plan, estimated_seconds: 0 };
    expect(jobPercent(job({ plan: unknown, stage: "encoding_prompt" }), clock({ elapsed: 3, inRunning: 3 }))).toBeGreaterThan(0);
  });

  it("shows the time left only once the engine's pace is known", () => {
    expect(remainingSeconds(job({ stage: "generating", step: [4, 8], seconds_per_step: 1.5 }), clock({}))).toBeCloseTo(4 * 1.5 + 1.5 + 5 + 1);
    expect(remainingSeconds(job({ stage: "generating", step: [0, 8] }), clock({}))).toBeNull();
    expect(remainingSeconds(job({ status: "starting_backend" }), clock({}))).toBeNull();
  });
});

describe("upscaling", () => {
  it("presets are real enlargements within limits", () => {
    const t = upscaleTargets(1376, 768);
    expect(t.map((x) => x.key)).toEqual(["2x", "4k"]);
    expect(t[0]).toMatchObject({ width: 2752, height: 1536 });
    expect(t[1]).toMatchObject({ width: 3840, height: 2143 });
    // Portrait 4K uses the long side.
    expect(upscaleTargets(768, 1376).find((x) => x.key === "4k")).toMatchObject({ width: 2143, height: 3840 });
    // A 1 MP edit of a 5120x2880 photo can go back to the photo's size.
    expect(upscaleTargets(1376, 768, { width: 5120, height: 2880 }).map((x) => x.key)).toEqual(["2x", "4k", "source"]);
    expect(upscaleTargets(5120, 2880, { width: 5120, height: 2880 }).map((x) => x.key), "2x is over 40 MP; 4K and source are not larger").toEqual([]);
    expect(upscaleTargets(4000, 4000).length).toBe(0);
  });
  it("custom width keeps the aspect", () => {
    expect(sizeForWidth(1376, 768, 3000)).toEqual({ width: 3000, height: 1674 });
  });
  it("builds an upscale request without a prompt", () => {
    const r = upscaleRequest("gen:abc", { width: 2752, height: 1536 }, "abc");
    expect(r).toMatchObject({ mode: "upscale", images: ["gen:abc"], prompt: "", parent_id: "abc", upscale: { method: "quick", width: 2752, height: 1536 } });
  });
  it("summarises the pipeline for the details panel", () => {
    const g = {
      width: 2752, height: 1536, working_width: 2048, working_height: 1152,
      pipeline: {
        base: { width: 1376, height: 768 }, refine: "fast", refine_steps: 6, refine_denoise: 0.35, hires_upscaler: "4x-UltraSharp",
        cache_threshold: 0.2, enlarged_with: "4x-UltraSharp", enlarged_from: { width: 2048, height: 1152 },
      },
    } as unknown as GenerationRecord;
    expect(pipelineSummary(g)).toBe("1376×768 → refined 2048×1152 (Fast, 6 steps, UltraSharp) → 2752×1536 (UltraSharp)");
    const edit = { ...g, width: 5120, height: 2880, pipeline: { ...g.pipeline!, base: null, enlarged_from: { width: 1376, height: 768 }, enlarged_with: "Lanczos" } } as GenerationRecord;
    expect(pipelineSummary(edit)).toBe("1376×768 → 5120×2880 (Lanczos)");
    expect(pipelineSummary({ ...g, pipeline: null } as GenerationRecord)).toBeNull();
  });
  it("describes plans", () => {
    const p = {
      output: { width: 2752, height: 1536 }, working: { width: 2080, height: 1152 }, content: { x: 12, y: 2, width: 2056, height: 1148 },
      upscaler: "4xNomos2_hq_mosr", upscale: null,
    } as unknown as Plan;
    expect(planPipeline(p)).toBe("2080×1152 render → 2752×1536 output (MoSR)");
    const quick = { ...p, upscaler: null, upscale: { method: "quick", source: { width: 1376, height: 768 } } } as Plan;
    expect(planPipeline(quick)).toBe("1376×768 → 2752×1536 (Lanczos)");
  });
});

describe("before / after comparison", () => {
  const rec = (mode: string, extra: Partial<GenerationRecord> = {}) =>
    ({ mode, references: [{ index: 0, input_id: "in1", width: 1000, height: 500 }], outpaint: null, ...extra }) as unknown as GenerationRecord;

  it("edits, inpaints, upscales and LUT results compare against the whole source", () => {
    for (const m of ["edit", "inpaint", "upscale", "lut"]) expect(compareBase(rec(m))).toEqual({ inputId: "in1", rect: { x: 0, y: 0, w: 1, h: 1 } });
  });

  it("an expanded image places the source inside the larger result", () => {
    const b = compareBase(rec("outpaint", { outpaint: { left: 500, right: 500, top: 0, bottom: 500 } }))!;
    expect(b.rect).toEqual({ x: 0.25, y: 0, w: 0.5, h: 0.5 });
  });

  it("a LUT result says which LUT and how strong", () => {
    const lut = { name: "Warm Film", title: null, intensity: 0.8 };
    expect(lutInfo(rec("lut", { request: { mode: "lut", images: ["gen:a"], lut } as unknown as GenerationRecord["request"] }))).toEqual(lut);
    expect(lutInfo(rec("edit", { request: null }))).toBeNull();
  });

  it("new images and multi-reference results have no before", () => {
    expect(compareBase(rec("generate"))).toBeNull();
    expect(compareBase(rec("multi_reference"))).toBeNull();
    expect(compareBase(rec("edit", { references: [] }))).toBeNull();
  });

  it("marks only pixels that changed beyond the threshold, and uncovered pixels", () => {
    const after = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255, 200, 0, 0, 255, 50, 50, 50, 255]);
    const before = new Uint8ClampedArray([100, 100, 100, 255, 110, 100, 100, 255, 0, 0, 0, 255, 0, 0, 0, 0]);
    const out = new Uint8ClampedArray(16);
    expect(diffPixels(after, before, out)).toBe(0.5);
    expect(out[0]).toBe(out[1]); // unchanged: grey
    expect(out[4]).toBe(out[5]); // small change below the threshold: grey
    expect(out[8]).toBeGreaterThan(out[9]); // big change: red
    expect(out[12]).toBeGreaterThan(out[13]); // not covered by the source (expanded): red
  });
});

describe("project versions", () => {
  it("numbers each new image, and the images made from it within it", () => {
    // import, edit, edit; new image, its edit; new seed of the new image; edit of the first
    // import again; combine led by the second image; a pending edit of 1.1.
    const items = [
      { key: "a", source: "input:a", from: [] },
      { key: "b", source: "gen:b", from: ["input:a"] },
      { key: "c", source: "gen:c", from: ["gen:b"] },
      { key: "d", source: "gen:d", from: [] },
      { key: "e", source: "gen:e", from: ["gen:d"] },
      { key: "f", source: "gen:f", from: ["gen:d"], variant: true },
      { key: "g", source: "gen:g", from: ["input:a"] },
      { key: "h", source: "gen:h", from: ["gen:d", "gen:c"] },
      { key: "i", source: null, from: ["gen:b"] },
    ];
    expect(versionLabels(items)).toEqual({ a: "1", b: "1.1", c: "1.2", d: "2", e: "2.1", f: "3", g: "1.3", h: "2.2", i: "1.4" });
  });

  it("formats project age", () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("setup wizard", () => {
  const item = (p: Partial<InstallItem>): InstallItem => ({
    id: "x", label: "X", kind: "model", size: 4_199_565_024, received: 0, state: "pending", error: null, hint: null, url: "", page: "", path: "", ...p,
  });
  it("formats sizes like download pages", () => {
    expect(formatBytes(4_199_565_024)).toBe("4.2 GB");
    expect(formatBytes(14_230_275_808)).toBe("14 GB");
    expect(formatBytes(66_961_958)).toBe("67 MB");
    expect(formatBytes(512)).toBe("1 KB");
  });
  it("counts progress only over files still to install", () => {
    const p = installProgress([item({ state: "present", received: 100, size: 100 }), item({ size: 200, received: 50, state: "downloading" })]);
    expect(p).toEqual({ received: 50, total: 200, frac: 0.25 });
    expect(installProgress([item({ state: "present" })]).frac).toBe(1);
  });
  it("summarizes the progress panel", () => {
    expect(installItemShort(item({ state: "downloading", received: 2_099_782_512 }))).toBe("50%");
    expect(installItemShort(item({ state: "cancelled", received: 4_000_000_000 }))).toBe("Paused · 200 MB left");
    expect(installItemShort(item({ state: "present" }))).toBe("Installed");
    expect(installStep([item({ state: "done" }), item({ label: "VAE", state: "verifying" })])).toBe("Checking VAE");
    expect(installStep([item({ state: "pending" })])).toBeNull();
    expect(installTimeLeft(12e9, 100e6)).toBe("about 2 min left");
    expect(installTimeLeft(1e9, 100e6)).toBe("less than a minute left");
    expect(installTimeLeft(1e9, 0)).toBeNull();
  });
  it("describes each file state", () => {
    expect(installItemText(item({ state: "downloading", received: 1e9 }), 50e6)).toBe("1.0 GB of 4.2 GB · 50 MB/s · 1m 4s left");
    expect(installItemText(item({}), 0)).toBe("To download · 4.2 GB");
    expect(installItemText(item({ state: "failed", error: "HTTP 404" }), 0)).toBe("HTTP 404");
    expect(installItemText(item({ state: "cancelled", received: 2e9 }), 0)).toContain("continues where it stopped");
  });
});

describe("undo between versions", () => {
  const items = [
    { key: "orig", source: "input:a", from: null },
    { key: "v1", source: "gen:1", from: "input:a" },
    { key: "v2", source: "gen:2", from: "gen:1" },
    { key: "v3", source: "gen:3", from: "input:a" }, // a second edit of the original
    { key: "t2i", source: "gen:4", from: null },
  ];
  it("goes back to the image a version was made from", () => {
    expect(undoTarget(items, "v2")).toBe("v1");
    expect(undoTarget(items, "v3")).toBe("orig");
  });
  it("falls back to the previous version, and stops at the first", () => {
    expect(undoTarget(items, "t2i")).toBe("v3");
    expect(undoTarget(items, "orig")).toBeNull();
    expect(undoTarget(items, "missing")).toBeNull();
  });
});

describe("timeline links", () => {
  // Original -> v1 (edit) -> v2 (edit); v3 new image; v4 edits v3; v5 edits v1 again;
  // v6 combines v2 and v4; v7 is a new seed of v3; v8 comes from a file outside the project.
  const items = [
    { key: "orig", source: "input:a", from: [] },
    { key: "v1", source: "gen:1", from: ["input:a"] },
    { key: "v2", source: "gen:2", from: ["gen:1"] },
    { key: "v3", source: "gen:3", from: [] },
    { key: "v4", source: "gen:4", from: ["gen:3"] },
    { key: "v5", source: "gen:5", from: ["gen:1"] },
    { key: "v6", source: null, from: ["gen:2", "gen:4"] },
    { key: "v7", source: "gen:7", from: ["gen:3"], variant: true },
    { key: "v8", source: "gen:8", from: ["C:\elsewhere.png"] },
  ];
  const l = timelineLinks(items);
  it("continues a line, and breaks it for a new image", () => {
    expect(l.orig).toEqual({ kind: "start", parents: [] });
    expect(l.v1).toEqual({ kind: "next", parents: ["orig"] });
    expect(l.v2.kind).toBe("next");
    expect(l.v3.kind).toBe("start");
    expect(l.v4).toEqual({ kind: "next", parents: ["v3"] });
  });
  it("joins versions made from earlier or several versions", () => {
    expect(l.v5).toEqual({ kind: "branch", parents: ["v1"] });
    expect(l.v6).toEqual({ kind: "combine", parents: ["v2", "v4"] });
    expect(l.v7).toEqual({ kind: "branch", parents: ["v3"] });
    expect(l.v8.kind).toBe("start");
  });
  it("marks a new seed of the version just before", () => {
    const v = timelineLinks([
      { key: "a", source: "gen:1", from: [] },
      { key: "b", source: "gen:2", from: ["gen:1"], variant: true },
    ]);
    expect(v.b).toEqual({ kind: "variant", parents: ["a"] });
  });
});

describe("aspect ratios", () => {
  it("parses ratios within the service's 1:8 to 8:1 range", () => {
    expect(parseRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseRatio("2.35 : 1")).toBeCloseTo(2.35);
    expect(parseRatio("1920x1080")).toBeCloseTo(16 / 9);
    expect(parseRatio("10:1")).toBeNull();
    expect(parseRatio("wide")).toBeNull();
  });
  it("names sizes by their ratio", () => {
    expect(aspectLabel(1920, 1080)).toBe("16:9");
    expect(aspectLabel(2752, 1536)).toBe("16:9");
    expect(aspectLabel(1400, 1000)).toBe("7:5");
    expect(aspectLabel(1850, 1000)).toBe("1.85:1");
    expect(aspectLabel(1000, 1850)).toBe("1:1.85");
  });
  it("keeps the pixel count when the ratio changes", () => {
    const s = sizeForRatio(16 / 9, 1024 * 1024);
    expect(s.width % 16 + (s.height % 16)).toBe(0);
    expect(Math.abs((s.width * s.height) / (1024 * 1024) - 1)).toBeLessThan(0.03);
    expect(aspectLabel(s.width, s.height)).toBe("16:9");
  });
  it("expands to a ratio or an exact size without cropping", () => {
    expect(expandToRatio(1000, 1000, 2)).toEqual({ left: 500, right: 500, top: 0, bottom: 0, units: "pixels" });
    expect(expandToRatio(2000, 1000, 1)).toEqual({ left: 0, right: 0, top: 500, bottom: 500, units: "pixels" });
    expect(expandToSize(1000, 800, 1501, 700)).toEqual({ left: 250, right: 251, top: 0, bottom: 0, units: "pixels" });
  });
});

describe("timeline arcs", () => {
  it("puts an arc above every shorter arc it overlaps", () => {
    // 1->3 and 3->5 only touch at 3 (overlap), 0->6 spans both, 7->8 is apart.
    const p = arcLayout([{ a: 1, b: 3 }, { a: 3, b: 5 }, { a: 0, b: 6 }, { a: 7, b: 8 }]);
    expect(p[0].lane).toBe(0);
    expect(p[1].lane).toBe(1);
    expect(p[2].lane).toBe(2);
    expect(p[3].lane).toBe(0);
  });
  it("spreads ends that meet at one item, keeping the order of the other ends", () => {
    // Both arcs end at 6 (a combine of 2 and 4); the one from further left ends further left.
    const p = arcLayout([{ a: 4, b: 6 }, { a: 2, b: 6 }]);
    expect(p[1].dx2).toBeLessThan(p[0].dx2);
    expect(p[0].dx2 + p[1].dx2).toBe(0);
    expect(p[0].dx1).toBe(0);
  });
});

describe("gallery preview", () => {
  it("stays on the same image when the list shifts", () => {
    // A new image arrives at the top: the shown image moves down one place.
    expect(previewIndex(["a", "b", "c"], "b", 1)).toBe(1);
    expect(previewIndex(["new", "a", "b", "c"], "b", 1)).toBe(2);
  });
  it("falls back to the last position when the image is gone", () => {
    expect(previewIndex(["a", "c"], "b", 1)).toBe(1);
    expect(previewIndex(["a"], "b", 4)).toBe(0);
    expect(previewIndex([], "b", 0)).toBeNull();
  });
  it("moves to a neighbour on removal", () => {
    expect(neighbourAfterRemoval(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourAfterRemoval(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourAfterRemoval(["a"], "a")).toBeNull();
    expect(neighbourAfterRemoval(["a"], "x")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("rounds to whole seconds before splitting minutes", () => {
    expect(formatDuration(0.2)).toBe("1s");
    expect(formatDuration(59.4)).toBe("59s");
    expect(formatDuration(59.6)).toBe("1m");
    expect(formatDuration(119.6)).toBe("2m");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3900)).toBe("65m");
  });
});

describe("star prompt", () => {
  it("waits for enough images and a free screen", () => {
    expect(starPromptDue(STAR_PROMPT_AFTER - 1, false)).toBe(false);
    expect(starPromptDue(STAR_PROMPT_AFTER, true)).toBe(false);
    expect(starPromptDue(STAR_PROMPT_AFTER, false)).toBe(true);
    expect(starPromptDue(STAR_PROMPT_AFTER + 3, false)).toBe(true);
  });
});
