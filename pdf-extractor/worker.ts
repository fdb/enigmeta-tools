// Runs the WASM PDF extraction off the main thread so the UI stays responsive
// on large files, posting progress messages back as it works.

import init, { extract } from "../src/wasm/pdf-extract/pdf_extract.js";
import wasmUrl from "../src/wasm/pdf-extract/pdf_extract_bg.wasm?url";

const ctx: any = self;

let ready: Promise<unknown> | null = null;
const ensureWasm = () => (ready ??= init({ module_or_path: wasmUrl }));

interface PlainAsset {
  kind: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  note: string;
  bytes: Uint8Array;
}

ctx.onmessage = async (e: MessageEvent) => {
  const { type, jobId, buffer } = e.data ?? {};
  if (type !== "extract") return;

  try {
    await ensureWasm();
    // Parsing happens inside extract() before any progress fires; tell the UI
    // to show an indeterminate state until the first object-count update.
    ctx.postMessage({ type: "progress", jobId, phase: "parse" });

    const data = new Uint8Array(buffer);
    let lastPct = -1;
    const onProgress = (done: number, total: number) => {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        ctx.postMessage({ type: "progress", jobId, phase: "extract", done, total });
      }
    };

    const result = extract(data, onProgress as unknown as Function);

    const assets: PlainAsset[] = [];
    const transfer: ArrayBuffer[] = [];
    const count = result.count;
    for (let i = 0; i < count; i++) {
      const a = result.get(i);
      if (!a) continue;
      const bytes = a.bytes; // fresh Uint8Array copied out of wasm memory
      assets.push({
        kind: a.kind,
        name: a.name,
        mime: a.mime,
        width: a.width,
        height: a.height,
        note: a.note,
        bytes,
      });
      transfer.push(bytes.buffer as ArrayBuffer);
      a.free();
    }
    result.free();

    // Transfer asset buffers back zero-copy.
    ctx.postMessage({ type: "done", jobId, assets }, transfer);
  } catch (err) {
    ctx.postMessage({
      type: "error",
      jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
