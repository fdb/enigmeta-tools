import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/site.css";
import "./style.css";
import { initTheme } from "../src/theme";

import { convertKey, type ConvertResult, type OutputFormat } from "./convert";

initTheme();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const input = $<HTMLTextAreaElement>("input");
const fileInput = $<HTMLInputElement>("file");
const passphrase = $<HTMLInputElement>("passphrase");
const togglePass = $<HTMLButtonElement>("toggle-pass");
const clearBtn = $<HTMLButtonElement>("clear");
const statusEl = $<HTMLParagraphElement>("status");
const result = $<HTMLElement>("result");
const summary = $<HTMLSpanElement>("summary");
const output = $<HTMLTextAreaElement>("output");
const copyBtn = $<HTMLButtonElement>("copy");
const downloadBtn = $<HTMLButtonElement>("download");

type Kind = "idle" | "busy" | "done" | "error";
function setStatus(text: string, kind: Kind) {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function selectedFormat(): OutputFormat {
  const el = form.querySelector<HTMLInputElement>('input[name="format"]:checked');
  return el?.value === "sec1" ? "sec1" : "pkcs8";
}

let lastResult: ConvertResult | null = null;

async function convert() {
  result.hidden = true;
  lastResult = null;
  setStatus("Converting…", "busy");

  // Yield a frame so the status paints before the (brief) bcrypt work runs.
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  try {
    const res = await convertKey(input.value, passphrase.value, selectedFormat());
    lastResult = res;
    output.value = res.pem;
    const bits = [`${res.keyType}`, `${res.format}`];
    if (res.comment) bits.push(`“${res.comment}”`);
    summary.textContent = bits.join(" · ");
    result.hidden = false;
    setStatus(res.note ?? `Converted to ${res.format}.`, "done");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void convert();
});

// Load a key file into the textarea (still fully local — just reads the file).
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    input.value = await f.text();
    setStatus(`Loaded ${f.name}. Press Convert.`, "idle");
  } catch {
    setStatus("Could not read that file.", "error");
  }
  fileInput.value = ""; // allow re-selecting the same file
});

togglePass.addEventListener("click", () => {
  const show = passphrase.type === "password";
  passphrase.type = show ? "text" : "password";
  togglePass.textContent = show ? "Hide" : "Show";
  togglePass.setAttribute("aria-pressed", String(show));
});

clearBtn.addEventListener("click", () => {
  input.value = "";
  passphrase.value = "";
  output.value = "";
  result.hidden = true;
  lastResult = null;
  setStatus("Cleared.", "idle");
  input.focus();
});

copyBtn.addEventListener("click", async () => {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  } catch {
    // Fallback for browsers without the async clipboard API.
    output.select();
    document.execCommand("copy");
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  }
});

downloadBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const name = lastResult.format === "SEC1" ? "private-key.sec1.pem" : "private-key.pkcs8.pem";
  const blob = new Blob([lastResult.pem], { type: "application/x-pem-file" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
