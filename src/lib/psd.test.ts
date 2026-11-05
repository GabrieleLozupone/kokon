import { describe, expect, it } from "vitest";
import { aiMarkingXmp, packBits, writePsd } from "./psd";

function unpack(p: ArrayLike<number>, at: number, len: number): number[] {
  const out: number[] = [];
  let i = at;
  while (i < at + len) {
    const n = p[i++];
    if (n < 128) for (let k = 0; k <= n; k++) out.push(p[i++]);
    else if (n > 128) {
      for (let k = 0; k < 257 - n; k++) out.push(p[i]);
      i++;
    }
  }
  return out;
}

/** Enough of a PSD reader for the file writePsd makes. */
function readPsd(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const u8 = () => b[o++];
  const u16 = () => ((o += 2), v.getUint16(o - 2));
  const u32 = () => ((o += 4), v.getUint32(o - 4));
  const s = (n: number) => String.fromCharCode(...b.subarray(o, (o += n)));
  /** A section by its u32 length (`o += u32()` would add to o as it was before the read). */
  const skip = () => {
    const n = u32();
    o += n;
  };
  expect(s(4)).toBe("8BPS");
  expect(u16()).toBe(1);
  o += 6;
  const channels = u16();
  const height = u32();
  const width = u32();
  expect([u16(), u16()]).toEqual([8, 3]);
  skip();
  // Image resources: 8BIM blocks (id, even-padded Pascal name, even-padded data).
  const resources = new Map<number, Uint8Array>();
  const resEnd = u32() + o;
  while (o < resEnd) {
    expect(s(4)).toBe("8BIM");
    const id = u16();
    const nl = u8();
    o += nl + ((nl + 1) % 2);
    const len = u32();
    resources.set(id, b.slice(o, o + len));
    o += len + (len % 2);
  }
  expect(o).toBe(resEnd);
  const masksLen = u32();
  const masksEnd = o + masksLen;
  const infoLen = u32();
  const infoEnd = o + infoLen;
  expect(infoLen % 2).toBe(0);
  const count = u16();
  const recs = [];
  for (let i = 0; i < count; i++) {
    const [top, left, bottom, right] = [u32(), u32(), u32(), u32()];
    const ch = u16();
    const lens = Array.from({ length: ch }, () => [v.getInt16((o += 6) - 6), v.getUint32(o - 4)]);
    expect(s(8)).toBe("8BIMnorm");
    const [, , flags] = [u8(), u8(), u8(), u8()];
    const extra = u32();
    const end = o + extra;
    skip();
    skip();
    const nl = u8();
    const short = s(nl);
    let name = short;
    o += (4 - ((nl + 1) % 4)) % 4;
    while (o < end) {
      expect(s(4)).toBe("8BIM");
      const key = s(4);
      const len = u32();
      if (key === "luni") {
        const n = v.getUint32(o);
        name = String.fromCharCode(...Array.from({ length: n }, (_, k) => v.getUint16(o + 4 + k * 2)));
      }
      o += len;
    }
    expect(o).toBe(end);
    recs.push({ top, left, bottom, right, lens, hidden: !!(flags & 2), name, short, pixels: [] as number[][] });
  }
  for (const r of recs) {
    const h = r.bottom - r.top;
    for (const [, len] of r.lens) {
      const start = o;
      const comp = u16();
      if (comp === 1) {
        const counts = Array.from({ length: h }, () => u16());
        const px: number[] = [];
        for (const n of counts) {
          px.push(...unpack(b, o, n));
          o += n;
        }
        r.pixels.push(px);
      } else r.pixels.push([]);
      expect(o - start).toBe(len);
    }
  }
  expect(o).toBeLessThanOrEqual(infoEnd);
  o = infoEnd;
  expect(u32()).toBe(0);
  expect(o).toBe(masksEnd);
  expect(u16()).toBe(1);
  const counts = Array.from({ length: channels * height }, () => u16());
  const flat: number[] = [];
  for (const n of counts) {
    flat.push(...unpack(b, o, n));
    o += n;
  }
  expect(o).toBe(b.length);
  return { width, height, channels, recs, flat, resources };
}

describe("psd", () => {
  it("packBits round-trips runs, literals and long rows", () => {
    const rows = [[1], [5, 5], [1, 2, 3], [0, 0, 0, 0, 7, 8, 9, 9, 9, 1], Array.from({ length: 700 }, (_, i) => (i < 300 ? 0 : i % 7))];
    for (const r of rows) {
      const p = packBits(Uint8Array.from(r));
      expect(unpack(p, 0, p.length)).toEqual(r);
    }
    expect(packBits(new Uint8Array(1000)).length).toBeLessThan(20);
  });

  it("writes each layer cropped to what it shows, bottom first, with its name and visibility", () => {
    const W = 6;
    const H = 4;
    const rgba = (f: (x: number, y: number) => number[] | null) => {
      const a = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a.set(f(x, y) ?? [0, 0, 0, 0], (y * W + x) * 4);
      return a;
    };
    const cup = rgba((x, y) => (x >= 2 && x <= 3 && y === 1 ? [200, 10, 20, 255] : null));
    const bg = rgba((x) => [x * 10, 50, 60, 255]);
    const empty = rgba(() => null);
    const flat = rgba((x) => [x, x, x, 255]);
    const out = readPsd(writePsd(W, H, [{ name: "Cup ☕", hidden: true, rgba: cup }, { name: "Nothing", hidden: false, rgba: empty }, { name: "Background", hidden: false, rgba: bg }], flat));
    expect([out.width, out.height, out.channels]).toEqual([W, H, 3]);
    expect(out.recs.map((r) => r.name)).toEqual(["Background", "Nothing", "Cup ☕"]);
    expect(out.recs[2].short).toBe("Cup _");
    expect(out.recs.map((r) => r.hidden)).toEqual([false, false, true]);
    const c = out.recs[2];
    expect([c.top, c.left, c.bottom, c.right]).toEqual([1, 2, 2, 4]);
    expect(c.lens.map((l) => l[0])).toEqual([-1, 0, 1, 2]);
    expect(c.pixels).toEqual([[255, 255], [200, 200], [10, 10], [20, 20]]);
    expect(out.recs[1].pixels).toEqual([[], [], [], []]);
    expect(out.recs[0].pixels[1].slice(0, W)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(out.flat.length).toBe(3 * W * H);
    expect(out.flat.slice(0, W)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("carries the AI marking as XMP (resource 1060) and still reads back", () => {
    const px = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]);
    const x = aiMarkingXmp("0.12.0", new Date(2026, 10, 4, 9, 5, 7));
    expect(x).toContain('Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia"');
    expect(x).toContain('xmp:CreatorTool="Kokon 0.12.0"');
    expect(x).toMatch(/xmp:CreateDate="2026-11-04T09:05:07[+-]\d\d:\d\d"/);
    expect(aiMarkingXmp('a"<b')).toContain('Kokon a&quot;&lt;b"');
    // Odd and even packet lengths both keep the sections aligned.
    for (const packet of [x, x + " "]) {
      const out = readPsd(writePsd(3, 1, [{ name: "L", hidden: false, rgba: px }], px, packet));
      expect(new TextDecoder().decode(out.resources.get(1060))).toBe(packet);
      expect(out.flat.slice(0, 3)).toEqual([1, 4, 7]);
    }
    expect(readPsd(writePsd(3, 1, [], px)).resources.size).toBe(0);
  });
});
