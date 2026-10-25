// Encode RGBA pixels to PNG, JPEG or WebP with the browser's encoders, then
// write the resolution into the file so print software gets the size right.

import type { Img } from "./types";

export type Format = "png" | "jpeg" | "webp";

export const EXT: Record<Format, string> = { png: "png", jpeg: "jpg", webp: "webp" };

export async function encode(img: Img, format: Format, quality: number, ppi: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = img.w;
  canvas.height = img.h;
  const ctx = canvas.getContext("2d")!;
  const data = new ImageData(
    new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length),
    img.w,
    img.h,
  );
  if (format === "jpeg") {
    // JPEG has no alpha; flatten onto white rather than the encoder's black.
    const tmp = document.createElement("canvas");
    tmp.width = img.w;
    tmp.height = img.h;
    tmp.getContext("2d")!.putImageData(data, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, img.w, img.h);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.putImageData(data, 0, 0);
  }
  const mime = `image/${format}`;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, quality));
  if (!blob) throw new Error(`this browser cannot encode ${format.toUpperCase()}`);
  if (blob.type !== mime) throw new Error(`this browser cannot encode ${format.toUpperCase()}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const out = format === "png" ? pngWithPpi(bytes, ppi) : format === "jpeg" ? jpegWithPpi(bytes, ppi) : bytes;
  return new Blob([out as BlobPart], { type: mime });
}

// PNG: insert a pHYs chunk (pixels per metre) right after IHDR.
function pngWithPpi(png: Uint8Array, ppi: number): Uint8Array {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4; // signature + IHDR length, type, data, CRC
  if (png.length < ihdrEnd) return png;
  const ppm = Math.round(ppi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

// JPEG: browsers write a JFIF APP0 segment with density 1:1 and no unit; set
// it to dots per inch. Left alone if the segment is not where we expect it.
function jpegWithPpi(jpg: Uint8Array, ppi: number): Uint8Array {
  const isJfif =
    jpg[0] === 0xff &&
    jpg[1] === 0xd8 &&
    jpg[2] === 0xff &&
    jpg[3] === 0xe0 &&
    String.fromCharCode(...jpg.subarray(6, 10)) === "JFIF" &&
    jpg[10] === 0;
  if (!isJfif) return jpg;
  const d = Math.min(65535, Math.round(ppi));
  jpg[13] = 1; // units: dots per inch
  jpg[14] = d >> 8;
  jpg[15] = d & 0xff;
  jpg[16] = d >> 8;
  jpg[17] = d & 0xff;
  return jpg;
}

let table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
