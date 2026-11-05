import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handlers, label, schemas, toErrorResult } from "../src/tools";

const obj = <K extends keyof typeof schemas>(k: K) => z.object(schemas[k]);

describe("input validation", () => {
  it("prompt is required and trimmed", () => {
    expect(obj("generate_image").safeParse({ prompt: "  " }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: " a fox " }).data?.prompt).toBe("a fox");
  });
  it("dimensions, aspect, quality, seed", () => {
    expect(obj("generate_image").safeParse({ prompt: "x", width: 32, height: 512 }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", width: 5000, height: 512 }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", aspect_ratio: "16:9" }).success).toBe(true);
    expect(obj("generate_image").safeParse({ prompt: "x", aspect_ratio: "wide" }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", quality: "quality" }).success).toBe(true);
    expect(obj("generate_image").safeParse({ prompt: "x", quality: "ultra" }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", quality: "max" }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", seed: -2 }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", reference_images: ["a.png", "b.png"] }).data?.reference_images).toEqual(["a.png", "b.png"]);
    expect(obj("generate_image").safeParse({ prompt: "x", reference_images: Array(11).fill("a.png") }).success).toBe(false);
  });
  it("edit tools warn against reusing the source's seed", () => {
    for (const k of ["edit_image", "edit_images", "inpaint_image", "outpaint_image"] as const) {
      // As clients see it: the JSON Schema of the tool's input.
      const seed = (z.toJSONSchema(obj(k)) as { properties: Record<string, { description?: string }> }).properties.seed;
      expect(seed.description).toMatch(/Never reuse the seed the source image was generated with/);
    }
    const gen = (z.toJSONSchema(obj("generate_image")) as { properties: Record<string, { description?: string }> }).properties.seed;
    expect(gen.description).toMatch(/^Seed for reproducible results/);
    expect(gen.description).not.toMatch(/source image/);
  });
  it("generate_video validation", () => {
    expect(obj("generate_video").safeParse({ prompt: "a sunset over the sea", frames: 49, fps: 16 }).success).toBe(true);
    expect(obj("generate_video").safeParse({ prompt: "a sunset", image_path: "frame.png" }).success).toBe(true);
    expect(obj("generate_video").safeParse({ prompt: "  " }).success).toBe(false);
    expect(obj("generate_video").safeParse({ prompt: "x", frames: 5 }).success).toBe(false);
  });
  it("edit_images limits and order", () => {
    expect(obj("edit_images").safeParse({ prompt: "x", image_paths: [] }).success).toBe(false);
    expect(obj("edit_images").safeParse({ prompt: "x", image_paths: Array(11).fill("a.png") }).success).toBe(false);
    expect(obj("edit_images").safeParse({ prompt: "x", image_paths: ["b.png", "a.png"] }).data?.image_paths).toEqual(["b.png", "a.png"]);
  });
  it("outpaint defaults", () => {
    const r = obj("outpaint_image").parse({ image_path: "a.png", prompt: "x", left: 256 });
    expect(r).toMatchObject({ left: 256, right: 0, top: 0, bottom: 0, units: "pixels" });
  });
  it("sends the caller's prompt as written: Kokon's Prompt+ never runs for MCP", async () => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      call: async (method: string, _path: string, body?: Record<string, unknown>) => {
        if (method === "POST" && body) sent.push(body);
        return { id: "j", status: "failed", error: { code: "x", message: "stop here" }, results: [], notes: [], queue_position: 0, plan: null, stage: null, step: null };
      },
    };
    const ctx = { client: client as never, cwd: process.cwd(), progress: () => {} };
    await handlers.generate_image({ prompt: "A watercolour fox in snow." } as never, ctx);
    await handlers.generate_image({ prompt: "x", enhance: true } as never, ctx);
    expect(sent.map((b) => [b.prompt, b.enhance, b.mode])).toEqual([
      ["A watercolour fox in snow.", false, "generate"],
      ["x", false, "generate"],
    ]);
  });
  it("an output in a QLS_MCP_ALLOWED_DIRS folder is sent with that folder as the workspace (#39)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qls-mcp-ws-"));
    const [proj, extra] = [path.join(tmp, "proj"), path.join(tmp, "thumbs")];
    fs.mkdirSync(proj);
    fs.mkdirSync(extra);
    const sent: Record<string, unknown>[] = [];
    const client = {
      call: async (method: string, p: string, body?: Record<string, unknown>) => {
        if (p === "/config") return { outputDir: path.join(tmp, "out") };
        if (method === "POST" && body) sent.push(body);
        return { id: "j", status: "failed", error: { code: "x", message: "stop here" }, results: [], notes: [], queue_position: 0, plan: null, stage: null, step: null };
      },
    };
    const ctx = { client: client as never, cwd: proj, progress: () => {} };
    const before = process.env.QLS_MCP_ALLOWED_DIRS;
    process.env.QLS_MCP_ALLOWED_DIRS = extra;
    try {
      await handlers.generate_image({ prompt: "x", output_path: path.join(extra, "Upscaled", "a.png") } as never, ctx);
      await handlers.generate_image({ prompt: "x", output_path: "a.png" } as never, ctx);
      await handlers.generate_image({ prompt: "x" } as never, ctx);
    } finally {
      if (before === undefined) delete process.env.QLS_MCP_ALLOWED_DIRS;
      else process.env.QLS_MCP_ALLOWED_DIRS = before;
    }
    expect(sent.map((b) => b.workspace)).toEqual([extra, proj, proj]);
  });
  it("width without height is rejected before any service call", async () => {
    const ctx = { client: {} as never, cwd: process.cwd(), progress: () => {} };
    const res = await handlers.generate_image({ prompt: "x", width: 512 } as never, ctx).catch(toErrorResult);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/both width and height/);
  });
});

describe("upscale_image", () => {
  it("validates factor and size", () => {
    expect(obj("upscale_image").safeParse({ image_path: "a.png" }).success).toBe(true);
    expect(obj("upscale_image").safeParse({ image_path: "a.png", scale: 1 }).success).toBe(false);
    expect(obj("upscale_image").safeParse({ image_path: "a.png", width: 9000 }).success).toBe(false);
  });
  it("scale and width together are rejected before any service call", async () => {
    const ctx = { client: {} as never, cwd: process.cwd(), progress: () => {} };
    const res = await handlers.upscale_image({ image_path: "a.png", scale: 2, width: 4000 } as never, ctx).catch(toErrorResult);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/either scale or width/);
  });
});

describe("progress labels are truthful", () => {
  const j = { id: "j", status: "running", stage: "generating", step: [3, 30] as [number, number], queue_position: 0, plan: null, results: [], error: null, notes: [] };
  it("only shows steps when reported", () => {
    expect(label(j)).toBe("Generating step 3/30");
    expect(label({ ...j, step: null })).toBe("Generating");
    expect(label({ ...j, status: "starting_backend" })).toBe("Loading the model");
    expect(label({ ...j, stage: "upscaling", step: null })).toBe("Upscaling");
    expect(label({ ...j, stage: "refining", step: [2, 6] })).toBe("Refining step 2/6");
  });
});
