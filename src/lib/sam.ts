// Click-to-select for the layers lab (components/LayersEditor.tsx): MobileSAM (Apache-2.0, Acly's
// ONNX export, MIT) run in the webview with onnxruntime-web. Experimental: the model files are not
// shipped; the vite dev server serves them from `lab-models/mobilesam/` (gitignored). The planned
// app version runs SAM in kokon-service instead.
//
// The encoder runs once per image (longest side 1024, 0-255 RGB, HWC); the decoder runs per click
// on the cached embeddings and returns SAM's 4 masks at the size asked for: index 0 = the single-mask
// output, 1-3 = sub-part / part / whole (their order and the predicted IoU are unreliable, S1).

import type * as Ort from "onnxruntime-web";

const MODEL_DIR = "/lab-models/mobilesam/";
const SIDE = 1024;

let ort: Promise<typeof Ort> | null = null;
const loadOrt = () => (ort ??= import("onnxruntime-web"));

export interface SamResult {
  /** Logits (> 0 = selected) at the size passed to `predict`, one per output. */
  masks: Float32Array[];
  iou: number[];
}

export class Segmenter {
  private emb: Ort.Tensor | null = null;
  private scale = 1;

  private constructor(
    private o: typeof Ort,
    private enc: Ort.InferenceSession,
    private dec: Ort.InferenceSession,
    /** The execution provider the encoder runs on. */
    readonly device: string,
  ) {}

  /** Null when the model files are not there (a release build). */
  static async load(webgpu = true): Promise<Segmenter | null> {
    const head = await fetch(MODEL_DIR + "sam_mask_decoder_multi.onnx", { method: "HEAD" }).catch(() => null);
    if (!head?.ok || head.headers.get("content-type")?.includes("text/html")) return null;
    const o = await loadOrt();
    o.env.logLevel = "error";
    // WebGPU when the webview has it, else WASM (one thread: the page is not cross-origin isolated).
    let enc: Ort.InferenceSession | null = null;
    let device = "wasm";
    if (webgpu && "gpu" in navigator) {
      try {
        enc = await o.InferenceSession.create(MODEL_DIR + "mobile_sam_image_encoder.onnx", { executionProviders: ["webgpu"] });
        device = "webgpu";
      } catch {
        enc = null;
      }
    }
    enc ??= await o.InferenceSession.create(MODEL_DIR + "mobile_sam_image_encoder.onnx", { executionProviders: ["wasm"] });
    const dec = await o.InferenceSession.create(MODEL_DIR + "sam_mask_decoder_multi.onnx", { executionProviders: ["wasm"] });
    return new Segmenter(o, enc, dec, device);
  }

  /** Encodes `img` (any size); clicks are then in the coordinates of a `w`×`h` mask of it. */
  async encode(img: CanvasImageSource, w: number, h: number) {
    this.scale = SIDE / Math.max(w, h);
    const rw = Math.max(1, Math.round(w * this.scale));
    const rh = Math.max(1, Math.round(h * this.scale));
    const c = document.createElement("canvas");
    c.width = rw;
    c.height = rh;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, rw, rh);
    const px = ctx.getImageData(0, 0, rw, rh).data;
    const x = new Float32Array(rw * rh * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      x[j] = px[i];
      x[j + 1] = px[i + 1];
      x[j + 2] = px[i + 2];
    }
    const out = await this.enc.run({ input_image: new this.o.Tensor("float32", x, [rh, rw, 3]) });
    this.emb = out.image_embeddings;
  }

  /** `points` in mask px (`w`×`h`, the size passed to `encode`); label 1 = object, 0 = not.
   * `box`: the object is inside it (corners as labels 2 and 3, in place of the padding point). */
  async predict(points: { x: number; y: number; label: 0 | 1 }[], w: number, h: number, box?: { x0: number; y0: number; x1: number; y1: number }): Promise<SamResult> {
    if (!this.emb) throw new Error("encode first");
    const all: { x: number; y: number; label: number }[] = [...points];
    if (box) all.push({ x: box.x0, y: box.y0, label: 2 }, { x: box.x1, y: box.y1, label: 3 });
    const n = all.length + (box ? 0 : 1);
    const coords = new Float32Array(n * 2);
    const labels = new Float32Array(n);
    all.forEach((p, i) => {
      coords[i * 2] = p.x * this.scale;
      coords[i * 2 + 1] = p.y * this.scale;
      labels[i] = p.label;
    });
    if (!box) labels[n - 1] = -1; // padding point: no box
    const T = this.o.Tensor;
    const out = await this.dec.run({
      image_embeddings: this.emb,
      point_coords: new T("float32", coords, [1, n, 2]),
      point_labels: new T("float32", labels, [1, n]),
      mask_input: new T("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new T("float32", new Float32Array([0]), [1]),
      orig_im_size: new T("float32", new Float32Array([h, w]), [2]),
    });
    const m = out.masks;
    const [, k, mh, mw] = m.dims as number[];
    if (mw !== w || mh !== h) throw new Error(`mask size ${mw}x${mh}, expected ${w}x${h}`);
    const data = m.data as Float32Array;
    const masks = Array.from({ length: k }, (_, i) => data.subarray(i * w * h, (i + 1) * w * h));
    return { masks, iou: Array.from(out.iou_predictions.data as Float32Array) };
  }
}
