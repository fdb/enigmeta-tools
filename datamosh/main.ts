import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/site.css";
import "./style.css";
import { initTheme } from "../src/theme";

import { captureFile, mosh, play, vp8Supported } from "./mosh";
import type { CapturedClip, MoshParams, Player } from "./mosh";
import { muxWebm } from "./webm";
import { startLive } from "./live";
import type { LiveController } from "./live";

initTheme();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const unsupportedEl = $<HTMLParagraphElement>("unsupported");
const tabFile = $<HTMLButtonElement>("tab-file");
const tabCam = $<HTMLButtonElement>("tab-cam");
const panelFile = $<HTMLElement>("panel-file");
const panelCam = $<HTMLElement>("panel-cam");
const dropzone = $<HTMLLabelElement>("dropzone");
const fileInput = $<HTMLInputElement>("file");
const progressEl = $<HTMLDivElement>("progress");
const progressBar = $<HTMLDivElement>("progress-bar");
const fileControls = $<HTMLFieldSetElement>("file-controls");
const statusEl = $<HTMLParagraphElement>("status");
const viewport = $<HTMLDivElement>("viewport");
const canvas = $<HTMLCanvasElement>("canvas");

const bitrateInput = $<HTMLInputElement>("bitrate");
const bitrateOut = $<HTMLOutputElement>("bitrate-out");
const meltInput = $<HTMLInputElement>("melt");
const bloomEveryInput = $<HTMLInputElement>("bloom-every");
const bloomEveryOut = $<HTMLOutputElement>("bloom-every-out");
const bloomRepeatsInput = $<HTMLInputElement>("bloom-repeats");
const bloomRepeatsOut = $<HTMLOutputElement>("bloom-repeats-out");
const dropInput = $<HTMLInputElement>("drop");
const dropOut = $<HTMLOutputElement>("drop-out");
const exportRawBtn = $<HTMLButtonElement>("export-raw");
const exportBakedBtn = $<HTMLButtonElement>("export-baked");

const camStartBtn = $<HTMLButtonElement>("cam-start");
const camControls = $<HTMLDivElement>("cam-controls");
const camBloomBtn = $<HTMLButtonElement>("cam-bloom");
const camDropBtn = $<HTMLButtonElement>("cam-drop");
const camResyncBtn = $<HTMLButtonElement>("cam-resync");
const camRecordBtn = $<HTMLButtonElement>("cam-record");

let clip: CapturedClip | null = null; // encoded (pre-mosh) source
let moshed: CapturedClip | null = null;
let player: Player | null = null;
let live: LiveController | null = null;
let baseName = "video";
let capturing = false;
let exporting = false;

function setStatus(text: string, kind: "idle" | "busy" | "done" | "error") {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const bitrateBps = () => Math.round(parseFloat(bitrateInput.value) * 1_000_000);

const params = (): MoshParams => ({
  meltCuts: meltInput.checked,
  bloomEvery: parseInt(bloomEveryInput.value, 10),
  bloomRepeats: parseInt(bloomRepeatsInput.value, 10),
  dropChance: parseInt(dropInput.value, 10) / 100,
});

function showCanvas() {
  viewport.dataset.empty = "false";
}

function stopPlayer() {
  player?.stop();
  player = null;
}

function startPreview() {
  if (!moshed) return;
  stopPlayer();
  showCanvas();
  player = play(canvas, moshed, true);
}

function remosh() {
  if (!clip) return;
  moshed = mosh(clip, params());
  startPreview();
}

// --- file mode -------------------------------------------------------------

async function handleFile(file: File) {
  if (capturing || exporting) return;
  capturing = true;
  stopPlayer();
  clip = null;
  moshed = null;
  fileControls.hidden = true;
  baseName = file.name.replace(/\.[^.]+$/, "") || "video";

  setStatus(`Re-encoding ${file.name} to VP8… (plays through once, in real time)`, "busy");
  progressEl.hidden = false;
  progressBar.style.width = "0%";

  try {
    clip = await captureFile(file, {
      bitrate: bitrateBps(),
      onProgress: (f) => {
        progressBar.style.width = `${Math.round(f * 100)}%`;
      },
    });
    const keys = clip.chunks.filter((c) => c.type === "key").length;
    setStatus(
      `Captured ${clip.chunks.length} frames at ${clip.fps} fps · ${keys} keyframe${keys === 1 ? "" : "s"} planted ` +
        `(1 kept + ${keys - 1} at scene cuts, ready to be ripped out). Tweak the parameters below.`,
      "done",
    );
    fileControls.hidden = false;
    remosh();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    progressEl.hidden = true;
    capturing = false;
  }
}

// Re-mosh live as parameters move — pure bitstream work, no re-encode.
let remoshTimer = 0;
function scheduleRemosh() {
  clearTimeout(remoshTimer);
  remoshTimer = window.setTimeout(() => {
    if (!exporting) remosh();
  }, 150);
}

function bindOutput(input: HTMLInputElement, out: HTMLOutputElement) {
  const update = () => (out.textContent = input.value);
  input.addEventListener("input", update);
  update();
}

bindOutput(bitrateInput, bitrateOut);
bindOutput(bloomEveryInput, bloomEveryOut);
bindOutput(bloomRepeatsInput, bloomRepeatsOut);
bindOutput(dropInput, dropOut);

for (const el of [meltInput, bloomEveryInput, bloomRepeatsInput, dropInput]) {
  el.addEventListener("input", scheduleRemosh);
}

function exportRaw() {
  if (!moshed) return;
  const bytes = muxWebm(moshed.chunks, moshed.width, moshed.height);
  downloadBlob(new Blob([bytes.buffer as ArrayBuffer], { type: "video/webm" }), `${baseName}-moshed.webm`);
  setStatus("Saved the raw moshed bitstream. It will glitch differently in every player — that's the point.", "done");
}

async function exportBaked() {
  if (!moshed || exporting) return;
  exporting = true;
  exportBakedBtn.disabled = true;
  setStatus("Baking… replaying the mosh once while recording the canvas.", "busy");
  stopPlayer();
  try {
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const recorded: BlobPart[] = [];
    const recorder = new MediaRecorder(canvas.captureStream(moshed.fps), mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recorded.push(e.data);
    };
    const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
    recorder.start(250);
    player = play(canvas, moshed, false);
    await player.finished;
    recorder.stop();
    await stopped;
    downloadBlob(new Blob(recorded, { type: recorder.mimeType || "video/webm" }), `${baseName}-moshed-baked.webm`);
    setStatus("Baked and saved.", "done");
  } finally {
    exporting = false;
    exportBakedBtn.disabled = false;
    startPreview();
  }
}

exportRawBtn.addEventListener("click", exportRaw);
exportBakedBtn.addEventListener("click", () => void exportBaked());

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void handleFile(f);
  fileInput.value = "";
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
  if (f) void handleFile(f);
});

// --- webcam mode -----------------------------------------------------------

async function stopCamera() {
  if (!live) return;
  const rec = await live.stopRecording();
  if (rec) downloadBlob(rec, "webcam-mosh.webm");
  live.stop();
  live = null;
  camControls.hidden = true;
  camStartBtn.textContent = "Start camera";
  camRecordBtn.setAttribute("aria-pressed", "false");
}

async function startCamera() {
  if (live) {
    await stopCamera();
    setStatus("Camera stopped.", "idle");
    return;
  }
  setStatus("Requesting camera…", "busy");
  try {
    live = await startLive(canvas, bitrateBps());
    showCanvas();
    camControls.hidden = false;
    camStartBtn.textContent = "Stop camera";
    setStatus("Live. The picture will drift on its own — perform with Bloom, Drop and Resync.", "done");
  } catch (err) {
    setStatus(
      err instanceof Error && err.name === "NotAllowedError"
        ? "Camera access was denied."
        : `Could not start the camera: ${err instanceof Error ? err.message : err}`,
      "error",
    );
  }
}

camStartBtn.addEventListener("click", () => void startCamera());

/** Wire a press-and-hold button (pointer + keyboard). */
function bindHold(btn: HTMLButtonElement, set: (on: boolean) => void) {
  const on = () => {
    btn.setAttribute("aria-pressed", "true");
    set(true);
  };
  const off = () => {
    btn.setAttribute("aria-pressed", "false");
    set(false);
  };
  btn.addEventListener("pointerdown", (e) => {
    btn.setPointerCapture(e.pointerId);
    on();
  });
  btn.addEventListener("pointerup", off);
  btn.addEventListener("pointercancel", off);
  btn.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) on();
  });
  btn.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") off();
  });
  btn.addEventListener("blur", off);
}

bindHold(camBloomBtn, (v) => live?.setBloom(v));
bindHold(camDropBtn, (v) => live?.setDrop(v));
camResyncBtn.addEventListener("click", () => live?.resync());

camRecordBtn.addEventListener("click", async () => {
  if (!live) return;
  if (camRecordBtn.getAttribute("aria-pressed") === "true") {
    camRecordBtn.setAttribute("aria-pressed", "false");
    const blob = await live.stopRecording();
    if (blob) {
      downloadBlob(blob, "webcam-mosh.webm");
      setStatus("Recording saved.", "done");
    }
  } else {
    camRecordBtn.setAttribute("aria-pressed", "true");
    live.startRecording();
    setStatus("Recording the moshed output…", "busy");
  }
});

// --- tabs ------------------------------------------------------------------

function selectTab(cam: boolean) {
  tabFile.setAttribute("aria-selected", String(!cam));
  tabCam.setAttribute("aria-selected", String(cam));
  panelFile.hidden = cam;
  panelCam.hidden = !cam;
  if (cam) {
    stopPlayer();
    setStatus("Start the camera to mosh yourself in real time.", "idle");
  } else {
    void stopCamera();
    if (moshed) {
      startPreview();
      setStatus("Back to the file mosh.", "idle");
    } else {
      setStatus("Drop a video to mosh it.", "idle");
    }
  }
}

tabFile.addEventListener("click", () => selectTab(false));
tabCam.addEventListener("click", () => selectTab(true));

// --- support check ---------------------------------------------------------

void vp8Supported().then((ok) => {
  if (!ok) {
    unsupportedEl.hidden = false;
    dropzone.style.pointerEvents = "none";
    dropzone.style.opacity = "0.5";
    camStartBtn.disabled = true;
    setStatus("WebCodecs VP8 support is missing in this browser.", "error");
  }
});
