// Minimal WebM (Matroska/EBML) muxer for a single VP8 video track.
//
// This exists so the moshed bitstream can be saved *as-is*: the resulting
// .webm genuinely has its keyframes missing and its P-frames duplicated, and
// glitches in any player — the authentic datamosh artifact, not a screen
// recording of one.

import type { MoshChunk } from "./mosh";

/** Encode an EBML element ID (IDs are stored with their marker bits intact). */
function ebmlId(id: number): Uint8Array {
  const bytes: number[] = [];
  do {
    bytes.unshift(id & 0xff);
    id = Math.floor(id / 256);
  } while (id > 0);
  return new Uint8Array(bytes);
}

/** Encode an EBML size as a minimal-length VINT. */
function ebmlSize(n: number): Uint8Array {
  let len = 1;
  // A VINT of `len` bytes holds 7*len bits; the all-ones value is reserved.
  while (n >= 2 ** (7 * len) - 1) len++;
  const bytes = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    bytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  bytes[0] |= 0x100 >> len; // length marker
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function el(id: number, payload: Uint8Array | Uint8Array[]): Uint8Array {
  const body = Array.isArray(payload) ? concat(payload) : payload;
  return concat([ebmlId(id), ebmlSize(body.length), body]);
}

function uintEl(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, new Uint8Array(bytes));
}

function strEl(id: number, value: string): Uint8Array {
  return el(id, new TextEncoder().encode(value));
}

function floatEl(id: number, value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value);
  return el(id, buf);
}

const MS_PER_CLUSTER = 30_000; // SimpleBlock timecodes are int16 ms offsets

/** Mux VP8 chunks (timestamps in µs) into a self-contained .webm file. */
export function muxWebm(chunks: MoshChunk[], width: number, height: number): Uint8Array {
  const header = el(0x1a45dfa3, [
    uintEl(0x4286, 1), // EBMLVersion
    uintEl(0x42f7, 1), // EBMLReadVersion
    uintEl(0x42f2, 4), // EBMLMaxIDLength
    uintEl(0x42f3, 8), // EBMLMaxSizeLength
    strEl(0x4282, "webm"), // DocType
    uintEl(0x4287, 2), // DocTypeVersion
    uintEl(0x4285, 2), // DocTypeReadVersion
  ]);

  const last = chunks[chunks.length - 1];
  const durationMs = last ? (last.timestamp + last.duration) / 1000 : 0;

  const info = el(0x1549a966, [
    uintEl(0x2ad7b1, 1_000_000), // TimecodeScale: 1 ms
    floatEl(0x4489, durationMs), // Duration (in timecode units)
    strEl(0x4d80, "enigmeta-datamosh"), // MuxingApp
    strEl(0x5741, "enigmeta-datamosh"), // WritingApp
  ]);

  const tracks = el(0x1654ae6b, [
    el(0xae, [
      uintEl(0xd7, 1), // TrackNumber
      uintEl(0x73c5, 1), // TrackUID
      uintEl(0x83, 1), // TrackType: video
      uintEl(0x9c, 0), // FlagLacing
      strEl(0x86, "V_VP8"), // CodecID
      el(0xe0, [uintEl(0xb0, width), uintEl(0xba, height)]), // Video
    ]),
  ]);

  const clusters: Uint8Array[] = [];
  let clusterStart = -1;
  let blocks: Uint8Array[] = [];

  const flushCluster = () => {
    if (clusterStart < 0) return;
    clusters.push(el(0x1f43b675, [uintEl(0xe7, clusterStart), ...blocks]));
    blocks = [];
    clusterStart = -1;
  };

  for (const chunk of chunks) {
    const tMs = Math.round(chunk.timestamp / 1000);
    if (clusterStart < 0 || tMs - clusterStart > MS_PER_CLUSTER || chunk.type === "key") {
      flushCluster();
      clusterStart = tMs;
    }
    const rel = tMs - clusterStart;
    const head = new Uint8Array(4);
    head[0] = 0x81; // track number 1 as VINT
    head[1] = (rel >> 8) & 0xff;
    head[2] = rel & 0xff;
    head[3] = chunk.type === "key" ? 0x80 : 0x00; // flags
    blocks.push(el(0xa3, concat([head, chunk.data]))); // SimpleBlock
  }
  flushCluster();

  const segment = el(0x18538067, [info, tracks, ...clusters]);
  return concat([header, segment]);
}
