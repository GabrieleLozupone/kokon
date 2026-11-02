// Layered Photoshop file (.psd, 8-bit RGB) of the Layers lab's document: each layer a pixel layer
// cropped to what it shows, RLE (PackBits) channels, and the flattened image for apps that read
// only that. Layer names in Unicode ('luni'), hidden layers kept hidden.

export interface PsdLayer {
  name: string;
  hidden: boolean;
  /** RGBA of the whole `width`×`height` document. */
  rgba: Uint8ClampedArray;
}

/** PackBits of one row: runs of 2+ equal bytes (up to 128) as -(n-1), b; the rest as literals. */
export function packBits(src: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run > 1) {
      out.push(257 - run, src[i]);
      i += run;
      continue;
    }
    // Literals until the next run of 3 (a run of 2 inside literals costs as much as copying it).
    let n = 0;
    while (i + n < src.length && n < 128 && !(i + n + 2 < src.length && src[i + n] === src[i + n + 1] && src[i + n] === src[i + n + 2])) n++;
    n = Math.max(1, n);
    out.push(n - 1);
    for (let k = 0; k < n; k++) out.push(src[i + k]);
    i += n;
  }
  return out;
}

class Writer {
  private buf = new Uint8Array(1 << 20);
  len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.len++] = v & 255;
  }
  u16(v: number) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number) {
    this.u16(v >>> 16);
    this.u16(v);
  }
  bytes(b: ArrayLike<number>) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  /** Reserves a u32 for a section's length, written by the returned function at its end. */
  length(): () => void {
    const at = this.len;
    this.u32(0);
    return () => {
      const n = this.len - at - 4;
      this.buf[at] = n >>> 24;
      this.buf[at + 1] = (n >>> 16) & 255;
      this.buf[at + 2] = (n >>> 8) & 255;
      this.buf[at + 3] = n & 255;
    };
  }
  pad(multiple: number, from = 0) {
    while ((this.len - from) % multiple) this.u8(0);
  }
  done = () => this.buf.slice(0, this.len);
}

/** One channel of the `w`×`h` box at (x0, y0) of an RGBA image `W` wide: the row byte counts, then
 * the rows, PackBits. `channel` 0-3 (3: alpha). */
function rleChannel(rgba: Uint8ClampedArray, W: number, x0: number, y0: number, w: number, h: number, channel: number) {
  const counts: number[] = [];
  const data: number[][] = [];
  const row = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const o = ((y0 + y) * W + x0) * 4 + channel;
    for (let x = 0; x < w; x++) row[x] = rgba[o + x * 4];
    const p = packBits(row);
    counts.push(p.length);
    data.push(p);
  }
  return { counts, data, size: 2 + h * 2 + counts.reduce((a, b) => a + b, 0) };
}

/** The box of pixels with any alpha (null: the layer shows nothing). */
function opaqueBox(rgba: Uint8ClampedArray, W: number, H: number) {
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!rgba[(y * W + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The .psd file: `layers` top first (as the lab lists them), `flat` the flattened image (opaque). */
export function writePsd(width: number, height: number, layers: PsdLayer[], flat: Uint8ClampedArray): Uint8Array {
  const w = new Writer();
  // Header: RGB, 8 bits, 3 channels in the flattened image.
  w.ascii("8BPS");
  w.u16(1);
  w.bytes([0, 0, 0, 0, 0, 0]);
  w.u16(3);
  w.u32(height);
  w.u32(width);
  w.u16(8);
  w.u16(3);
  w.u32(0); // colour mode data
  w.u32(0); // image resources

  const endMasks = w.length();
  const endInfo = w.length();
  const infoStart = w.len;
  // Photoshop lists records bottom first.
  const order = [...layers].reverse();
  w.u16(order.length);
  const channels = order.map((l) => {
    const box = opaqueBox(l.rgba, width, height);
    // Alpha (-1) first, then R, G, B.
    const list = box ? [3, 0, 1, 2].map((c) => rleChannel(l.rgba, width, box.x0, box.y0, box.w, box.h, c)) : null;
    return { box, list };
  });
  order.forEach((l, i) => {
    const { box, list } = channels[i];
    w.u32(box ? box.y0 : 0);
    w.u32(box ? box.x0 : 0);
    w.u32(box ? box.y0 + box.h : 0);
    w.u32(box ? box.x0 + box.w : 0);
    w.u16(4);
    [0xffff, 0, 1, 2].forEach((id, c) => {
      w.u16(id);
      w.u32(list ? list[c].size : 2);
    });
    w.ascii("8BIMnorm");
    w.u8(255); // opacity
    w.u8(0); // clipping
    w.u8((l.hidden ? 2 : 0) | 8); // bit 1: hidden; bit 3: bit 4 is meaningful
    w.u8(0);
    const endExtra = w.length();
    w.u32(0); // layer mask
    w.u32(0); // blending ranges
    // The name as a Pascal string (ASCII, padded to 4), then in full as 'luni'.
    const ascii = l.name.replace(/[^\x20-\x7e]/g, "_").slice(0, 255);
    const at = w.len;
    w.u8(ascii.length);
    w.ascii(ascii);
    w.pad(4, at);
    w.ascii("8BIMluni");
    const endLuni = w.length();
    const lat = w.len;
    w.u32(l.name.length);
    for (let k = 0; k < l.name.length; k++) w.u16(l.name.charCodeAt(k));
    w.pad(4, lat);
    endLuni();
    endExtra();
  });
  for (const { list } of channels)
    for (let c = 0; c < 4; c++) {
      if (!list) {
        w.u16(0);
        continue;
      }
      w.u16(1);
      for (const n of list[c].counts) w.u16(n);
      for (const row of list[c].data) w.bytes(row);
    }
  w.pad(2, infoStart);
  endInfo();
  w.u32(0); // global layer mask
  endMasks();

  // The flattened image: RLE, all rows' counts first, then R, G, B rows.
  const flatChannels = [0, 1, 2].map((c) => rleChannel(flat, width, 0, 0, width, height, c));
  w.u16(1);
  for (const ch of flatChannels) for (const n of ch.counts) w.u16(n);
  for (const ch of flatChannels) for (const row of ch.data) w.bytes(row);
  return w.done();
}
