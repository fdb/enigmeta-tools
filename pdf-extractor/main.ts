import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/site.css";
import { initTheme } from "../src/theme";

import { zipSync } from "fflate";
import init, { extract } from "../src/wasm/pdf-extract/pdf_extract.js";
// Vite resolves this to a served URL for the wasm binary.
import wasmUrl from "../src/wasm/pdf-extract/pdf_extract_bg.wasm?url";

initTheme();

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
const toolbar = $<HTMLDivElement>("toolbar");
const summary = $<HTMLSpanElement>("summary");
const gallery = $<HTMLDivElement>("gallery");
const downloadAllBtn = $<HTMLButtonElement>("download-all");

let wasmReady: Promise<unknown> | null = null;
const ensureWasm = () => (wasmReady ??= init({ module_or_path: wasmUrl }));

let current: PlainAsset[] = [];
let objectUrls: string[] = [];

function setStatus(text: string, kind: "idle" | "busy" | "done" | "error") {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
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

  setStatus(`Reading ${file.name}…`, "busy");
  try {
    await ensureWasm();
    const buf = new Uint8Array(await file.arrayBuffer());
    setStatus(`Extracting assets from ${file.name}…`, "busy");

    const result = extract(buf);
    try {
      const count = result.count;
      for (let i = 0; i < count; i++) {
        const a = result.get(i);
        if (!a) continue;
        current.push({
          kind: a.kind,
          name: a.name,
          mime: a.mime,
          width: a.width,
          height: a.height,
          note: a.note,
          bytes: a.bytes, // getter returns a fresh Uint8Array copy
        });
        a.free();
      }
    } finally {
      result.free();
    }

    if (current.length === 0) {
      setStatus("No embedded images or fonts found in this PDF.", "done");
      return;
    }

    const images = current.filter((a) => a.kind === "image").length;
    const fonts = current.filter((a) => a.kind === "font").length;
    summary.textContent = `${current.length} assets · ${images} images · ${fonts} fonts`;
    toolbar.hidden = false;
    render(current);
    setStatus(`Done. Extracted ${current.length} assets from ${file.name}.`, "done");
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

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
