import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/site.css";
import { initTheme } from "../src/theme";

import { zipSync } from "fflate";

initTheme();

// Extraction runs in a worker so large PDFs don't freeze the UI.
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

// A plain JS copy of an extracted asset, detached from WASM memory.
interface PlainAsset {
  kind: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  note: string;
  bytes: Uint8Array;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dropzone = $<HTMLLabelElement>("dropzone");
const fileInput = $<HTMLInputElement>("file");
const statusEl = $<HTMLParagraphElement>("status");
const progressEl = $<HTMLDivElement>("progress");
const progressBar = $<HTMLDivElement>("progress-bar");
const toolbar = $<HTMLDivElement>("toolbar");
const summary = $<HTMLSpanElement>("summary");
const gallery = $<HTMLDivElement>("gallery");
const downloadAllBtn = $<HTMLButtonElement>("download-all");

let current: PlainAsset[] = [];
let objectUrls: string[] = [];
let jobId = 0; // identifies the in-flight extraction; stale results are ignored
let jobName = "";

function setStatus(text: string, kind: "idle" | "busy" | "done" | "error") {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function showProgress(visible: boolean) {
  progressEl.hidden = !visible;
}

function setIndeterminate(on: boolean) {
  progressEl.classList.toggle("indeterminate", on);
  if (on) progressBar.style.width = "";
}

function setProgress(pct: number) {
  progressBar.style.width = `${pct}%`;
}

function revokeUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function blobUrl(bytes: Uint8Array, mime: string): string {
  // Copy into a fresh ArrayBuffer so the Blob owns contiguous bytes.
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  objectUrls.push(url);
  return url;
}

function downloadBytes(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  // The anchor must be in the document for the `download` filename to be
  // honoured (some browsers fall back to the blob's UUID otherwise).
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Ensure unique filenames within a single extraction (for the ZIP especially).
function uniqueNames(assets: PlainAsset[]): string[] {
  const seen = new Map<string, number>();
  return assets.map((a) => {
    const count = seen.get(a.name) ?? 0;
    seen.set(a.name, count + 1);
    if (count === 0) return a.name;
    const dot = a.name.lastIndexOf(".");
    return dot === -1
      ? `${a.name}-${count}`
      : `${a.name.slice(0, dot)}-${count}${a.name.slice(dot)}`;
  });
}

function tryFontPreview(el: HTMLElement, asset: PlainAsset) {
  // Browsers can only render ttf/otf via FontFace; skip Type1/CFF.
  if (asset.mime !== "font/ttf" && asset.mime !== "font/otf") return;
  const url = blobUrl(asset.bytes, asset.mime);
  const family = `pdffont-${asset.name.replace(/\W/g, "")}`;
  const face = new FontFace(family, `url(${url})`);
  face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
      el.style.fontFamily = `"${family}", serif`;
    })
    .catch(() => {
      /* keep the name fallback */
    });
}

function render(assets: PlainAsset[]) {
  revokeUrls();
  gallery.replaceChildren();
  const names = uniqueNames(assets);

  assets.forEach((asset, i) => {
    const name = names[i];
    const card = document.createElement("div");
    card.className = "asset";

    const thumb = document.createElement("div");
    if (asset.kind === "image" && asset.mime.startsWith("image/")) {
      thumb.className = "thumb";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = name;
      img.src = blobUrl(asset.bytes, asset.mime);
      thumb.appendChild(img);
    } else if (asset.kind === "font") {
      thumb.className = "thumb font";
      thumb.textContent = "Ag";
      tryFontPreview(thumb, asset);
    } else {
      thumb.className = "thumb font";
      thumb.textContent = "⬡";
    }

    const meta = document.createElement("div");
    meta.className = "meta";

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;

    const detail = document.createElement("span");
    detail.className = "detail";
    const dims =
      asset.width && asset.height ? `${asset.width}×${asset.height} · ` : "";
    detail.textContent = `${dims}${asset.note} · ${humanSize(asset.bytes.length)}`;

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "Download";
    btn.addEventListener("click", () =>
      downloadBytes(asset.bytes, name, asset.mime),
    );

    meta.append(nameEl, detail, btn);
    card.append(thumb, meta);
    gallery.appendChild(card);
  });
}

async function handleFile(file: File) {
  if (!file) return;
  revokeUrls();
  current = [];
  gallery.replaceChildren();
  toolbar.hidden = true;

  const id = ++jobId;
  jobName = file.name;
  setStatus(`Reading ${file.name}…`, "busy");
  showProgress(true);
  setIndeterminate(true);

  try {
    const buffer = await file.arrayBuffer();
    // Transfer the bytes into the worker (zero-copy) and let it report back.
    worker.postMessage({ type: "extract", jobId: id, buffer }, [buffer]);
  } catch (err) {
    showProgress(false);
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

interface WorkerMessage {
  type: "progress" | "done" | "error";
  jobId: number;
  phase?: "parse" | "extract";
  done?: number;
  total?: number;
  assets?: PlainAsset[];
  message?: string;
}

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.jobId !== jobId) return; // a newer file superseded this result

  if (msg.type === "progress") {
    if (msg.phase === "parse") {
      setStatus(`Parsing ${jobName}…`, "busy");
      setIndeterminate(true);
    } else {
      const pct = msg.total ? Math.round((msg.done! / msg.total) * 100) : 0;
      setIndeterminate(false);
      setProgress(pct);
      setStatus(`Extracting assets… ${pct}%`, "busy");
    }
    return;
  }

  if (msg.type === "error") {
    showProgress(false);
    setStatus(msg.message ?? "Extraction failed.", "error");
    return;
  }

  // done
  showProgress(false);
  current = msg.assets ?? [];
  if (current.length === 0) {
    setStatus(`No embedded images or fonts found in ${jobName}.`, "done");
    return;
  }
  const images = current.filter((a) => a.kind === "image").length;
  const fonts = current.filter((a) => a.kind === "font").length;
  summary.textContent = `${current.length} assets · ${images} images · ${fonts} fonts`;
  toolbar.hidden = false;
  render(current);
  setStatus(`Done. Extracted ${current.length} assets from ${jobName}.`, "done");
};

function downloadAll() {
  if (current.length === 0) return;
  const names = uniqueNames(current);
  const files: Record<string, Uint8Array> = {};
  current.forEach((a, i) => {
    files[names[i]] = a.bytes;
  });
  // level 0: assets are already compressed (PNG/JPEG/fonts); skip re-deflating.
  const zipped = zipSync(files, { level: 0 });
  downloadBytes(zipped, "pdf-assets.zip", "application/zip");
}

// --- wiring ----------------------------------------------------------------
// The dropzone is a <label> wrapping the file input, so a click opens the
// native picker with no JS needed. We only wire change + drag-and-drop here.

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  }),
);
["dragleave", "dragend", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  }),
);
dropzone.addEventListener("drop", (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

downloadAllBtn.addEventListener("click", downloadAll);
