// Runs resizing in WebAssembly off the main thread. The main thread sends the
// source image once, then a "run" per change; a newer run makes it terminate
// this worker rather than wait, since a seam-carving job cannot be paused.

import init, { Carver, nearest, resize } from "../src/wasm/image-resize/image_resize.js";
import wasmUrl from "../src/wasm/image-resize/image_resize_bg.wasm?url";
import type { Job, Img, WorkerOut } from "./types";

const ctx = self as unknown as {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let ready: Promise<unknown> | null = null;
const ensureWasm = () => (ready ??= init({ module_or_path: wasmUrl }));

let source: Img | null = null;
// The downscaled copy used for content-aware previews, keyed by pixel budget.
let previewCache: { key: string; img: Img } | null = null;

const SEAMS_PER_STEP = 4;

function scaled(img: Img, w: number, h: number, filter: string, linear: boolean): Img {
  if (img.w === w && img.h === h) return img;
  return { w, h, data: resize(img.data, img.w, img.h, w, h, filter, linear) };
}

function previewBase(job: Job): { img: Img; s: number } {
  const src = source!;
  const budget = job.previewMp * 1e6;
  const px = src.w * src.h;
  if (!job.preview || job.method !== "carve" || budget <= 0 || px <= budget) return { img: src, s: 1 };
  const s = Math.sqrt(budget / px);
  const w = Math.max(1, Math.round(src.w * s));
  const h = Math.max(1, Math.round(src.h * s));
  const key = `${w}x${h}:${job.filter}:${job.linear}`;
  if (previewCache?.key !== key) {
    previewCache = { key, img: scaled(src, w, h, job.filter, job.linear) };
  }
  return { img: previewCache.img, s: w / src.w };
}

function run(job: Job) {
  const t0 = performance.now();
  const { img: base, s } = previewBase(job);
  const tw = Math.max(1, Math.round(job.w * s));
  const th = Math.max(1, Math.round(job.h * s));

  if (job.method === "smooth" || job.method === "pixel") {
    const data =
      job.method === "pixel"
        ? nearest(base.data, base.w, base.h, tw, th)
        : resize(base.data, base.w, base.h, tw, th, job.filter, job.linear);
    const out: WorkerOut = {
      type: "done",
      id: job.id,
      result: { w: tw, h: th, data },
      ms: performance.now() - t0,
      seams: 0,
      preview: false,
    };
    ctx.postMessage(out, [data.buffer]);
    return;
  }

  // Content-aware: scale part of the way (1 - amount), then carve the rest.
  const a = job.amount;
  const iw = Math.max(1, Math.round(base.w + (1 - a) * (tw - base.w)));
  const ih = Math.max(1, Math.round(base.h + (1 - a) * (th - base.h)));
  const inter = scaled(base, iw, ih, job.filter, job.linear);

  const carver = new Carver(inter.data, iw, ih);
  carver.set_forward(job.forward);
  if (job.mask) carver.set_mask(job.mask.data, job.mask.w, job.mask.h);

  const total = Math.abs(tw - iw) + Math.abs(th - ih);
  let done = 0;
  let lastPost = 0;
  const progress = () => {
    const now = performance.now();
    if (now - lastPost < 50) return;
    lastPost = now;
    ctx.postMessage({ type: "progress", id: job.id, done, total });
  };

  const dims: Array<"w" | "h"> = job.order === "hw" ? ["h", "w"] : ["w", "h"];
  for (const dim of dims) {
    const rows = dim === "h";
    carver.set_rows(rows);
    const target = rows ? th : tw;
    let cur = carver.carve_width;
    while (cur > target) {
      const n = carver.remove_seams(Math.min(SEAMS_PER_STEP, cur - target));
      if (n === 0) break;
      cur -= n;
      done += n;
      progress();
    }
    while (cur < target) {
      // One pass can add at most half the current size, so a large
      // enlargement is several passes; otherwise the same seams get stretched.
      const want = Math.min(target - cur, Math.max(1, Math.floor(cur / 2)));
      const k = carver.begin_insert(want);
      if (k === 0) break;
      let left = k;
      while (left > 0) {
        const before = left;
        left = carver.insert_step(SEAMS_PER_STEP);
        done += before - left;
        progress();
      }
      carver.finish_insert();
      cur += k;
    }
  }
  carver.set_rows(false);

  const data = carver.rgba();
  const out: WorkerOut = {
    type: "done",
    id: job.id,
    result: { w: carver.width, h: carver.height, data },
    ms: performance.now() - t0,
    seams: total,
    preview: s !== 1,
  };
  const transfer: Transferable[] = [data.buffer];
  if (job.wantSeams) {
    const removed = carver.removed_map();
    const inserted = carver.inserted_map();
    out.carved = { base: inter, removed, inserted };
    transfer.push(removed.buffer, inserted.buffer);
    // `inter` may be the cached source or preview; send a copy.
    out.carved.base = { w: inter.w, h: inter.h, data: inter.data.slice() };
    transfer.push(out.carved.base.data.buffer);
  }
  carver.free();
  ctx.postMessage(out, transfer);
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    await ensureWasm();
    if (msg.type === "source") {
      source = msg.img as Img;
      previewCache = null;
    } else if (msg.type === "run") {
      if (!source) throw new Error("no image loaded");
      run(msg.job as Job);
    }
  } catch (err) {
    ctx.postMessage({
      type: "error",
      id: msg?.job?.id ?? -1,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
