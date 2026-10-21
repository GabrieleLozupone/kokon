// kokon-mcp — MCP server (stdio) for Kokon. Uses the same local service and
// generation engine as the desktop app. Works when the app is closed: the service and
// the inference server are started on demand. Everything stays on 127.0.0.1.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { handlers, schemas, toErrorResult, type ToolContext, type ToolResult } from "./tools.js";
import { ServiceClient } from "./service.js";
import pkg from "../package.json" with { type: "json" };

// Bundled in by esbuild: the one place to bump is package.json (see docs/releasing.md).
const VERSION = pkg.version;

const DESCRIPTIONS: Record<keyof typeof schemas, { title: string; description: string }> = {
  generate_image: {
    title: "Generate image",
    description:
      "Generate an image from a text prompt with the local Qwen-Image 2.1 model. Dimensions are chosen automatically (aspect ratio can be inferred from the prompt, e.g. '16:9 hero image') unless width/height or aspect_ratio are given. Returns the absolute path of the saved PNG. Runs fully offline; typically 45 s–4 min.",
  },
  edit_image: {
    title: "Edit image",
    description:
      "Edit an existing image with a natural-language instruction (e.g. 'make the background nighttime, keep the foreground unchanged'). Preserves the input's width, height and aspect ratio by default. The input file is never overwritten.",
  },
  edit_images: {
    title: "Edit with multiple references",
    description:
      "Create an image from several reference images (up to 10) and an instruction. Order matters: refer to them as image 1, image 2, ... in the prompt. The output follows image 1's aspect ratio unless width/height or aspect_ratio are given.",
  },
  outpaint_image: {
    title: "Expand image (outpaint)",
    description:
      "Extend an image beyond its borders. Give the expansion per side in pixels or percent; the canvas, mask and model-aligned sizes are built automatically and the original pixels are preserved exactly.",
  },
  inpaint_image: {
    title: "Inpaint image",
    description:
      "Change only the masked area of an image (mask: white = change, black = keep): edit it, remove what is there, replace it, or add something inside it. The model is shown the area marked on a copy of the image; pixels outside the mask are preserved exactly.",
  },
  upscale_image: {
    title: "Upscale image",
    description:
      "Enlarge an image (default 2x, or to a width/height up to 8192 px). Runs the upscaler model chosen in Kokon (Superscale-SP by default; seconds on a PC GPU, longer on a Mac; adds no new content). Saves a new file; the input is never overwritten.",
  },
  get_image_info: {
    title: "Image info",
    description: "Width, height, aspect ratio, file type and, for images made by Kokon, the generation metadata (prompt, seed, model, steps...).",
  },
  get_generator_status: {
    title: "Generator status",
    description: "Whether the local inference server is running and the model loaded, GPU and VRAM, the active job and the queue.",
  },
};

const client = new ServiceClient();
const server = new McpServer({ name: "kokon", version: VERSION }, { capabilities: { tools: {} } });

function toMcp(r: ToolResult) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: r.text }];
  if (r.previewJpeg) content.push({ type: "image", data: r.previewJpeg.toString("base64"), mimeType: "image/jpeg" });
  return { content, structuredContent: r.structured, isError: r.isError ?? false };
}

for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
  const d = DESCRIPTIONS[name];
  server.registerTool(
    name,
    {
      title: d.title,
      description: d.description,
      inputSchema: schemas[name],
      annotations: { readOnlyHint: name.startsWith("get_"), openWorldHint: false, destructiveHint: false, idempotentHint: name.startsWith("get_") },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any, extra: any) => {
      const token = extra?._meta?.progressToken;
      let n = 0;
      const ctx: ToolContext = {
        client,
        // Claude Code sets CLAUDE_PROJECT_DIR for MCP servers; otherwise use the working directory.
        cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        signal: extra?.signal,
        progress: (message) => {
          if (token === undefined) return;
          n += 1;
          extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message } }).catch(() => {});
        },
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return toMcp(await (handlers[name] as any)(args, ctx));
      } catch (e) {
        return toMcp(toErrorResult(e));
      }
    },
  );
}

async function main() {
  if (process.argv.includes("--version")) {
    process.stdout.write(`kokon-mcp ${VERSION}\n`);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await client.release();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`kokon-mcp failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
