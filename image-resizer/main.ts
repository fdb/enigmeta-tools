import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/site.css";
import "./style.css";
import { initTheme } from "../src/theme";

import type { Img, Job, Method, WorkerOut } from "./types";
import { formatFactor, formatLength, parseFactor, parseLength, toMm, trim } from "./size";
import type { Unit } from "./size";
import { encode, EXT } from "./encode";
import type { Format } from "./encode";

initTheme();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
const radio = (name: string) => radios(name).find((r) => r.checked)!.value;
const setRadio = (name: string, value: string) => radios(name).forEach((r) => (r.checked = r.value === value));

const dropzone = $<HTMLLabelElement>("dropzone");
const fileInput = $<HTMLInputElement>("file");
const dropTitle = $("drop-title");
const dropSub = $("drop-sub");
const sourceInfo = $("source-info");
const sections = ["size-section", "method-section", "export-section"].map((id) => $<HTMLFieldSetElement>(id));

const wInput = $<HTMLInputElement>("w");
const hInput = $<HTMLInputElement>("h");
const unitSel = $<HTMLSelectElement>("unit");
const lockBtn = $<HTMLButtonElement>("lock");
const ppiInput = $<HTMLInputElement>("ppi");
const pxReadout = $("px-readout");
const factorInput = $<HTMLInputElement>("factor");
const presets = $("presets");

const methodHint = $("method-hint");
const pixelOpts = $("pixel-opts");
const snapRow = $("snap-row");
const snapDown = $<HTMLButtonElement>("snap-down");
const snapUp = $<HTMLButtonElement>("snap-up");
const carveOpts = $("carve-opts");
const amountInput = $<HTMLInputElement>("amount");
const amountOut = $<HTMLOutputElement>("amount-out");
const brushSize = $<HTMLInputElement>("brush-size");
const brushSizeOut = $<HTMLOutputElement>("brush-size-out");
const maskClear = $<HTMLButtonElement>("mask-clear");
const filterRow = $("filter-row");
const filterSel = $<HTMLSelectElement>("filter");
const linearRow = $("linear-row");
const linearInput = $<HTMLInputElement>("linear");
const energySel = $<HTMLSelectElement>("energy");
const orderSel = $<HTMLSelectElement>("order");
const previewSel = $<HTMLSelectElement>("preview-mp");
const advHint = $("adv-hint");

const qualityRow = $("quality-row");
const qualityInput = $<HTMLInputElement>("quality");
const qualityOut = $<HTMLOutputElement>("quality-out");
const nameInput = $<HTMLInputElement>("name");
const downloadBtn = $<HTMLButtonElement>("download");
const copyBtn = $<HTMLButtonElement>("copy");
const progressEl = $("progress");
const progressBar = $("progress-bar");

const stageTools = $("stage-tools");
const viewSeams = $("view-seams");
const readout = $("readout");
const viewport = $("viewport");
const frame = $("frame");
const canvas = $<HTMLCanvasElement>("canvas");
const maskCanvas = $<HTMLCanvasElement>("mask");
const brushCursor = $("brush-cursor");
const statusEl = $("status");

// Output limits: browsers cap canvas sides around 16k-32k px, and the wasm
// filters need about 16 bytes per pixel of working memory.
const MAX_SIDE = 16384;
const MAX_PIXELS = 50e6;
const MASK_MAX = 1024;

const METHOD_HINT: Record<Method, string> = {
  smooth:
    "Resamples every pixel with a filter. For photos and anything continuous-tone. Filter and gamma under Advanced.",
  pixel:
    "Nearest neighbour: every pixel becomes a block of identical pixels, no blur. For pixel art, screenshots and icons. Whole-number factors give even blocks.",
  carve:
    "Seam carving, what Photoshop calls Content-Aware Scale: removes or duplicates the least noticeable paths of pixels, so the subject keeps its shape while the background gives. Best for changing proportions.",
};

const FILTER_NAME: Record<string, string> = {
  lanczos3: "Lanczos-3",
  lanczos2: "Lanczos-2",
  mitchell: "Mitchell",
  triangle: "bilinear",
  box: "box",
};

// ---- State ---------------------------------------------------------------

let src: Img | null = null;
let srcCanvas: HTMLCanvasElement | null = null;
let baseName = "image";
let tw = 0;
let th = 0;
let locked = true;
let nameEdited = false;
let hasMask = false;

type Done = Extract<WorkerOut, { type: "done" }>;
let last: Done | null = null;
let lastKey = "";

// ---- Status --------------------------------------------------------------

function setStatus(text: string, kind: "idle" | "busy" | "done" | "error") {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function setProgress(frac: number | null) {
  progressEl.hidden = frac === null;
  progressBar.style.width = `${Math.round((frac ?? 0) * 100)}%`;
}

// ---- Worker --------------------------------------------------------------

let worker: Worker | null = null;
let workerHasSource = false;
let inflight: {
  id: number;
  resolve: (d: Done) => void;
  reject: (e: Error) => void;
  onProgress?: (f: number) => void;
} | null = null;
let jobSeq = 0;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  workerHasSource = false;
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (!inflight || m.id !== inflight.id) return;
    if (m.type === "progress") inflight.onProgress?.(m.total ? m.done / m.total : 0);
    else if (m.type === "error") {
      const f = inflight;
      inflight = null;
      f.reject(new Error(m.message));
    } else {
      const f = inflight;
      inflight = null;
      f.resolve(m);
    }
  };
  worker.onerror = (e) => {
    const f = inflight;
    inflight = null;
    worker?.terminate();
    worker = null;
    f?.reject(new Error(e.message || "worker crashed (out of memory?)"));
  };
  return worker;
}

class Cancelled extends Error {}

function runJob(job: Omit<Job, "id">, onProgress?: (f: number) => void): Promise<Done> {
  if (inflight) {
    // A seam-carving pass cannot be interrupted, so start over in a new worker.
    worker?.terminate();
    worker = null;
    inflight.reject(new Cancelled());
    inflight = null;
  }
  const w = getWorker();
  if (!workerHasSource && src) {
    w.postMessage({ type: "source", img: { w: src.w, h: src.h, data: src.data.slice() } });
    workerHasSource = true;
  }
  const id = ++jobSeq;
  return new Promise<Done>((resolve, reject) => {
    inflight = { id, resolve, reject, onProgress };
    w.postMessage({ type: "run", job: { ...job, id } });
  });
}

// ---- Settings ------------------------------------------------------------

const method = () => radio("method") as Method;
const unit = () => unitSel.value as Unit;
const ppi = () => {
  const v = parseFloat(ppiInput.value);
  return Number.isFinite(v) && v > 0 ? v : 300;
};

function jobParams(preview: boolean): Omit<Job, "id"> {
  const m = method();
  return {
    method: m,
    w: tw,
    h: th,
    filter: filterSel.value,
    linear: linearInput.checked,
    amount: parseInt(amountInput.value, 10) / 100,
    forward: energySel.value === "forward",
    order: orderSel.value as "wh" | "hw",
    mask: m === "carve" && hasMask ? readMask() : null,
    preview,
    previewMp: parseFloat(previewSel.value),
    wantSeams: preview && m === "carve",
  };
}

/** Everything that changes the output pixels. */
function outputKey(): string {
  const m = method();
  const parts: unknown[] = [m, tw, th];
  if (m !== "pixel") parts.push(filterSel.value, linearInput.checked);
  if (m === "carve") parts.push(amountInput.value, energySel.value, orderSel.value, maskVersion);
  return JSON.stringify(parts);
}

// ---- Size UI -------------------------------------------------------------

function sizeError(): string | null {
  if (tw > MAX_SIDE || th > MAX_SIDE) return `Too large: sides are limited to ${MAX_SIDE} px.`;
  if (tw * th > MAX_PIXELS) return `Too large: ${trim((tw * th) / 1e6, 1)} MP, the limit is ${MAX_PIXELS / 1e6} MP.`;
  return null;
}

function renderSize(skip?: HTMLInputElement) {
  if (!src) return;
  const u = unit();
  if (skip !== wInput) wInput.value = formatLength(tw, u, src.w, ppi());
  if (skip !== hInput) hInput.value = formatLength(th, u, src.h, ppi());
  const fx = tw / src.w;
  const fy = th / src.h;
  if (skip !== factorInput) {
    factorInput.value = Math.abs(fx - fy) < 0.005 ? formatFactor(fx) : `${formatFactor(fx)} · ${formatFactor(fy)}`;
  }
  const mm = (v: number) => trim(toMm(v, ppi()), 1);
  pxReadout.innerHTML = "";
  const big = document.createElement("strong");
  big.textContent = `${tw} × ${th} px`;
  const small = document.createElement("span");
  small.textContent = `${mm(tw)} × ${mm(th)} mm at ${trim(ppi(), 1)} dpi · ${trim((tw * th) / 1e6, 2)} MP`;
  pxReadout.append(big, small);
  const err = sizeError();
  pxReadout.dataset.error = err ? "true" : "false";
  for (const b of presets.querySelectorAll<HTMLButtonElement>("button")) {
    const f = parseFloat(b.dataset.factor!);
    b.setAttribute(
      "aria-pressed",
      String(tw === Math.max(1, Math.round(src.w * f)) && th === Math.max(1, Math.round(src.h * f))),
    );
  }
  ppiInput.closest(".prop")!.classList.toggle("emph", u === "mm" || u === "cm");
  updateSnap();
  updateName();
}

function setFactor(f: number) {
  if (!src) return;
  tw = Math.max(1, Math.round(src.w * f));
  th = Math.max(1, Math.round(src.h * f));
}

function onDimInput(which: "w" | "h", input: HTMLInputElement) {
  if (!src) return;
  const orig = which === "w" ? src.w : src.h;
  const v = parseLength(input.value, unit(), orig, ppi());
  input.setAttribute("aria-invalid", String(v === null && input.value.trim() !== ""));
  if (v === null) return;
  if (which === "w") {
    tw = v;
    if (locked) th = Math.max(1, Math.round((v * src.h) / src.w));
  } else {
    th = v;
    if (locked) tw = Math.max(1, Math.round((v * src.w) / src.h));
  }
  renderSize(input);
  schedule();
}

wInput.addEventListener("input", () => onDimInput("w", wInput));
hInput.addEventListener("input", () => onDimInput("h", hInput));
for (const el of [wInput, hInput, factorInput]) {
  el.addEventListener("change", () => {
    el.removeAttribute("aria-invalid");
    renderSize();
  });
  el.addEventListener("keydown", (e) => {
    // Arrow keys nudge by one unit (shift: ten), like a number field.
    if (el === factorInput || !src || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
    const u = unit();
    const cur = parseFloat(el.value) || 0;
    el.value = trim(Math.max(u === "px" ? 1 : 0.1, cur + step), 2);
    onDimInput(el === wInput ? "w" : "h", el);
    renderSize();
  });
}

factorInput.addEventListener("input", () => {
  const f = parseFactor(factorInput.value);
  factorInput.setAttribute("aria-invalid", String(f === null && factorInput.value.trim() !== ""));
  if (f === null) return;
  setFactor(f);
  renderSize(factorInput);
  schedule();
});

unitSel.addEventListener("change", () => renderSize());
ppiInput.addEventListener("input", () => {
  // Keep the print size the person typed, so changing dpi changes pixels.
  const u = unit();
  if ((u === "mm" || u === "cm") && src) {
    const w = parseLength(wInput.value, u, src.w, ppi());
    const h = parseLength(hInput.value, u, src.h, ppi());
    if (w && h) {
      tw = w;
      th = locked ? Math.max(1, Math.round((w * src.h) / src.w)) : h;
      // Re-render, but leave the typed lengths as they were.
      const [wv, hv] = [wInput.value, hInput.value];
      renderSize();
      wInput.value = wv;
      if (!locked) hInput.value = hv;
      schedule();
      return;
    }
  }
  renderSize();
});

lockBtn.addEventListener("click", () => {
  locked = !locked;
  lockBtn.setAttribute("aria-pressed", String(locked));
  lockBtn.title = locked ? "Keep proportions" : "Proportions free";
  if (locked && src) {
    th = Math.max(1, Math.round((tw * src.h) / src.w));
    renderSize();
    schedule();
  }
});

presets.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-factor]");
  if (!b) return;
  setFactor(parseFloat(b.dataset.factor!));
  renderSize();
  schedule(0);
});

// Pixelated: offer the nearest whole factors when the current one is uneven.
function updateSnap() {
  if (!src || method() !== "pixel") {
    snapRow.hidden = true;
    return;
  }
  const f = tw / src.w;
  const even = (n: number) => Math.abs(n - Math.round(n)) < 1e-3;
  const sameAspect = Math.abs(f - th / src.h) < 0.01;
  if (!sameAspect || (f >= 1 ? even(f) : even(1 / f))) {
    snapRow.hidden = true;
    return;
  }
  let lo: number, hi: number;
  if (f >= 1) {
    lo = Math.max(1, Math.floor(f));
    hi = Math.ceil(f);
  } else {
    lo = 1 / Math.ceil(1 / f);
    hi = 1 / Math.floor(1 / f);
  }
  snapDown.textContent = `Snap to ${formatFactor(lo)}`;
  snapUp.textContent = `Snap to ${formatFactor(hi)}`;
  snapDown.dataset.factor = String(lo);
  snapUp.dataset.factor = String(hi);
  snapRow.hidden = false;
}
for (const b of [snapDown, snapUp]) {
  b.addEventListener("click", () => {
    setFactor(parseFloat(b.dataset.factor!));
    renderSize();
    schedule(0);
  });
}

// ---- Method UI -----------------------------------------------------------

function renderMethod() {
  const m = method();
  methodHint.textContent = METHOD_HINT[m];
  pixelOpts.hidden = m !== "pixel";
  carveOpts.hidden = m !== "carve";
  filterRow.hidden = m === "pixel";
  linearRow.hidden = m === "pixel";
  document.querySelector<HTMLElement>(".carve-adv")!.hidden = m !== "carve";
  advHint.textContent =
    m === "pixel"
      ? "Nearest neighbour has no filter to choose."
      : m === "carve"
        ? "The filter is used for the share of the change that Amount leaves to ordinary scaling, and for the preview. Previews of large images are carved at reduced size; the download is carved at full size."
        : "Lanczos-3 is the sharpest; Mitchell rings less around hard edges; box averages areas, good for big reductions.";
  viewSeams.hidden = m !== "carve";
  if (m !== "carve" && radio("view") === "seams") setRadio("view", "result");
  if (m !== "carve") setBrush("none");
  updateSnap();
  render();
}

for (const r of radios("method")) {
  r.addEventListener("change", () => {
    renderMethod();
    schedule(0);
  });
}
amountInput.addEventListener("input", () => {
  amountOut.textContent = amountInput.value;
  schedule();
});
for (const el of [filterSel, linearInput, energySel, orderSel, previewSel]) {
  el.addEventListener("change", () => schedule(0));
}

// ---- Export UI -----------------------------------------------------------

const format = () => radio("format") as Format;

function updateName() {
  if (nameEdited) return;
  nameInput.value = `${baseName}-${tw}x${th}`;
}
nameInput.addEventListener("input", () => (nameEdited = nameInput.value.trim() !== ""));

for (const r of radios("format")) {
  r.addEventListener("change", () => {
    qualityRow.hidden = format() === "png";
  });
}
qualityInput.addEventListener("input", () => (qualityOut.textContent = qualityInput.value));

async function finalImage(): Promise<Img> {
  if (last && lastKey === outputKey() && !last.preview) return last.result;
  setStatus("Rendering full size…", "busy");
  setProgress(0);
  const d = await runJob(jobParams(false), (f) => {
    setProgress(f);
    setStatus(`Carving at full size… ${Math.round(f * 100)}%`, "busy");
  });
  setProgress(null);
  return d.result;
}

async function exportBlob(fmt: Format): Promise<Blob> {
  const img = await finalImage();
  setStatus(`Encoding ${fmt.toUpperCase()}…`, "busy");
  return encode(img, fmt, parseInt(qualityInput.value, 10) / 100, ppi());
}

downloadBtn.addEventListener("click", async () => {
  if (!src || sizeError()) return;
  try {
    const fmt = format();
    const blob = await exportBlob(fmt);
    const name = `${(nameInput.value.trim() || `${baseName}-${tw}x${th}`).replace(/\.(png|jpe?g|webp)$/i, "")}.${EXT[fmt]}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Saved ${name} · ${tw} × ${th} px · ${formatBytes(blob.size)}`, "done");
  } catch (err) {
    setProgress(null);
    if (!(err instanceof Cancelled)) setStatus(`Export failed: ${(err as Error).message}`, "error");
  }
});

copyBtn.addEventListener("click", async () => {
  if (!src || sizeError()) return;
  try {
    // The clipboard only reliably takes PNG.
    const blob = exportBlob("png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus(`Copied ${tw} × ${th} px PNG to the clipboard.`, "done");
  } catch (err) {
    setProgress(null);
    if (!(err instanceof Cancelled)) setStatus(`Copy failed: ${(err as Error).message}`, "error");
  }
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${trim(n / 1024, 1)} KB`;
  return `${trim(n / 1024 / 1024, 1)} MB`;
}

// ---- Processing ----------------------------------------------------------

let timer = 0;
function schedule(delay?: number) {
  if (!src) return;
  clearTimeout(timer);
  timer = window.setTimeout(process, delay ?? (method() === "carve" ? 250 : 120));
}

async function process() {
  if (!src) return;
  const err = sizeError();
  if (err) {
    setStatus(err, "error");
    return;
  }
  const m = method();
  const key = outputKey();
  const t0 = performance.now();
  if (m === "carve") {
    setStatus("Carving seams…", "busy");
    setProgress(0);
  } else {
    setStatus("Resizing…", "busy");
  }
  try {
    const d = await runJob(jobParams(true), (f) => {
      setProgress(f);
      setStatus(`Carving seams… ${Math.round(f * 100)}%`, "busy");
    });
    setProgress(null);
    last = d;
    lastKey = key;
    render();
    const ms = performance.now() - t0;
    const time = ms < 1000 ? `${Math.round(ms)} ms` : `${trim(ms / 1000, 1)} s`;
    const what =
      m === "pixel"
        ? "Pixelated (nearest neighbour)"
        : m === "smooth"
          ? `Smooth · ${FILTER_NAME[filterSel.value]}${linearInput.checked ? " · linear light" : ""}`
          : `Content-aware · ${d.seams} seams${parseInt(amountInput.value, 10) < 100 ? ` · ${amountInput.value}% carved` : ""}`;
    const note = d.preview ? ` · preview at ${d.result.w} × ${d.result.h}, download carves full size` : "";
    setStatus(`${what} · ${src.w} × ${src.h} → ${tw} × ${th} px · ${time}${note}`, "done");
  } catch (e) {
    if (e instanceof Cancelled) return;
    setProgress(null);
    setStatus(`Failed: ${(e as Error).message}`, "error");
  }
}

// ---- Stage ---------------------------------------------------------------

const TINT_REMOVED = [235, 45, 60];
const TINT_INSERTED = [20, 190, 120];

function tinted(img: Img, map: Uint8Array, tint: number[]): Img {
  const out = img.data.slice();
  for (let i = 0; i < map.length; i++) {
    if (!map[i]) continue;
    const o = i * 4;
    out[o] = (out[o] * 0.25 + tint[0] * 0.75) | 0;
    out[o + 1] = (out[o + 1] * 0.25 + tint[1] * 0.75) | 0;
    out[o + 2] = (out[o + 2] * 0.25 + tint[2] * 0.75) | 0;
    out[o + 3] = 255;
  }
  return { w: img.w, h: img.h, data: out };
}

function putImg(img: Img) {
  canvas.width = img.w;
  canvas.height = img.h;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer.slice(0) as ArrayBuffer), img.w, img.h), 0, 0);
}

function render() {
  if (!src || !srcCanvas) return;
  viewport.dataset.empty = "false";
  stageTools.hidden = false;
  const view = radio("view");
  const m = method();
  let shownW = tw;
  let shownH = th;
  let label = "";
  maskCanvas.hidden = !(view === "original" && m === "carve");
  if (view === "original" || !last) {
    canvas.width = src.w;
    canvas.height = src.h;
    canvas.getContext("2d")!.drawImage(srcCanvas, 0, 0);
    shownW = src.w;
    shownH = src.h;
    label = `original · ${src.w} × ${src.h} px`;
  } else if (view === "seams" && last.carved) {
    const c = last.carved;
    const removed = c.removed.some((v) => v === 1);
    if (removed) {
      putImg(tinted(c.base, c.removed, TINT_REMOVED));
      shownW = c.base.w;
      shownH = c.base.h;
      label = `seams removed · shown on ${c.base.w} × ${c.base.h} px`;
    } else {
      putImg(tinted(last.result, c.inserted, TINT_INSERTED));
      shownW = last.result.w;
      shownH = last.result.h;
      label = `seams inserted · ${last.result.w} × ${last.result.h} px`;
    }
  } else {
    putImg(last.result);
    label = `result · ${tw} × ${th} px${last.preview ? ` (preview ${last.result.w} × ${last.result.h})` : ""}`;
  }
  frame.style.setProperty("--ar", String(shownW / shownH));
  frame.style.setProperty("--w", `${shownW}px`);
  frame.style.setProperty("--h", `${shownH}px`);
  // Pixel art looks wrong blurred by the display, so show it crisp.
  canvas.classList.toggle("crisp", m === "pixel" || radio("zoom") === "1");
  readout.textContent = label;
}

for (const r of radios("view")) r.addEventListener("change", render);
for (const r of radios("zoom")) {
  r.addEventListener("change", () => {
    viewport.dataset.zoom = radio("zoom");
    render();
  });
}

// ---- Mask painting -------------------------------------------------------

let maskVersion = 0;
const brush = () => radio("brush");

function setBrush(v: string) {
  setRadio("brush", v);
  frame.dataset.brush = v;
  brushCursor.hidden = true;
}

for (const r of radios("brush")) {
  r.addEventListener("change", () => {
    frame.dataset.brush = brush();
    // Painting happens on the original.
    if (brush() !== "none" && radio("view") !== "original") {
      setRadio("view", "original");
      render();
    }
  });
}
brushSize.addEventListener("input", () => (brushSizeOut.textContent = brushSize.value));

function resetMask() {
  if (!src) return;
  const s = Math.min(1, MASK_MAX / Math.max(src.w, src.h));
  maskCanvas.width = Math.max(1, Math.round(src.w * s));
  maskCanvas.height = Math.max(1, Math.round(src.h * s));
  hasMask = false;
  maskClear.disabled = true;
  maskVersion++;
}

function readMask(): Img {
  const { width: w, height: h } = maskCanvas;
  const px = maskCanvas.getContext("2d")!.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    if (px[o + 3] < 128) continue;
    out[i] = px[o + 1] > px[o] ? 1 : 2; // green = protect, red = remove
  }
  return { w, h, data: out };
}

maskClear.addEventListener("click", () => {
  maskCanvas.getContext("2d")!.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  hasMask = false;
  maskClear.disabled = true;
  maskVersion++;
  schedule(0);
});

let painting = false;
let lastPt: [number, number] | null = null;

function maskPoint(e: PointerEvent): [number, number] {
  const r = frame.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * maskCanvas.width, ((e.clientY - r.top) / r.height) * maskCanvas.height];
}

function brushRadius(): number {
  return (Math.max(maskCanvas.width, maskCanvas.height) * parseFloat(brushSize.value)) / 100 / 2;
}

function paintTo(pt: [number, number]) {
  const ctx = maskCanvas.getContext("2d")!;
  const b = brush();
  ctx.globalCompositeOperation = b === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = b === "protect" ? "rgb(20, 190, 120)" : "rgb(235, 45, 60)";
  ctx.lineWidth = brushRadius() * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const from = lastPt ?? pt;
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(pt[0] + 0.01, pt[1]);
  ctx.stroke();
  lastPt = pt;
}

function moveCursor(e: PointerEvent) {
  if (brush() === "none" || radio("view") !== "original" || method() !== "carve") {
    brushCursor.hidden = true;
    return;
  }
  const r = frame.getBoundingClientRect();
  const d = ((brushRadius() * 2) / maskCanvas.width) * r.width;
  brushCursor.hidden = false;
  brushCursor.style.width = brushCursor.style.height = `${d}px`;
  brushCursor.style.left = `${e.clientX - r.left}px`;
  brushCursor.style.top = `${e.clientY - r.top}px`;
}

frame.addEventListener("pointerdown", (e) => {
  if (brush() === "none" || radio("view") !== "original" || method() !== "carve") return;
  e.preventDefault();
  frame.setPointerCapture(e.pointerId);
  painting = true;
  lastPt = null;
  paintTo(maskPoint(e));
});
frame.addEventListener("pointermove", (e) => {
  moveCursor(e);
  if (painting) paintTo(maskPoint(e));
});
const endPaint = () => {
  if (!painting) return;
  painting = false;
  lastPt = null;
  hasMask = readMask().data.some((v) => v !== 0);
  maskClear.disabled = !hasMask;
  maskVersion++;
  schedule(0);
};
frame.addEventListener("pointerup", endPaint);
frame.addEventListener("pointercancel", endPaint);
frame.addEventListener("pointerleave", () => (brushCursor.hidden = true));

// ---- Loading -------------------------------------------------------------

async function load(file: File) {
  if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(file.name)) {
    setStatus(`${file.name} does not look like an image.`, "error");
    return;
  }
  setStatus(`Decoding ${file.name}…`, "busy");
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const id = ctx.getImageData(0, 0, c.width, c.height);
    src = { w: c.width, h: c.height, data: new Uint8Array(id.data.buffer) };
    srcCanvas = c;
  } catch {
    setStatus(`Could not decode ${file.name}.`, "error");
    return;
  }
  baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  nameEdited = false;
  nameInput.value = "";
  last = null;
  lastKey = "";
  // New source: the worker must get it again.
  worker?.terminate();
  worker = null;
  inflight?.reject(new Cancelled());
  inflight = null;
  tw = src.w;
  th = src.h;
  resetMask();
  setBrush("none");
  sections.forEach((s) => (s.disabled = false));
  dropTitle.textContent = file.name;
  dropSub.textContent = "Drop or click to replace.";
  sourceInfo.textContent = `${src.w} × ${src.h} px`;
  renderSize();
  renderMethod();
  setStatus(`Loaded ${file.name} · ${src.w} × ${src.h} px · ${formatBytes(file.size)}. Pick a size.`, "idle");
  schedule(0);
}

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) load(f);
  fileInput.value = "";
});

// Accept drops anywhere on the page, and paste.
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropzone.classList.add("dragover");
});
document.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) dropzone.classList.remove("dragover");
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const f = e.dataTransfer?.files[0];
  if (f) load(f);
});
document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  const f = item?.getAsFile();
  if (!f) return;
  e.preventDefault();
  load(new File([f], f.name && f.name !== "image.png" ? f.name : "pasted.png", { type: f.type }));
});

// Created once with the read-back hint: the mask is read after every stroke.
maskCanvas.getContext("2d", { willReadFrequently: true });
renderMethod();
qualityRow.hidden = true;
