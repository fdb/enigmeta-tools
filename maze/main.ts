import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/site.css";
import "./style.css";
import { initTheme } from "../src/theme";

import { buildGrid } from "./grid";
import type { Grid, GridKind, GridSpec } from "./grid";
import { ALGORITHMS, generate } from "./generate";
import type { Algorithm, Entrance, Maze } from "./generate";
import { renderSvg } from "./svg";

initTheme();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("controls");
const difficulty = $<HTMLInputElement>("difficulty");
const difficultyOut = $<HTMLOutputElement>("difficulty-out");
const colsField = $<HTMLLabelElement>("cols-field");
const cols = $<HTMLInputElement>("cols");
const rows = $<HTMLInputElement>("rows");
const rowsLabel = $<HTMLSpanElement>("rows-label");
const algorithm = $<HTMLSelectElement>("algorithm");
const algorithmNote = $<HTMLParagraphElement>("algorithm-note");
const biasField = $<HTMLDivElement>("bias-field");
const bias = $<HTMLInputElement>("bias");
const biasOut = $<HTMLOutputElement>("bias-out");
const braid = $<HTMLInputElement>("braid");
const braidOut = $<HTMLOutputElement>("braid-out");
const entrance = $<HTMLSelectElement>("entrance");
const entranceCenter = $<HTMLOptionElement>("entrance-center");
const seed = $<HTMLInputElement>("seed");
const newMaze = $<HTMLButtonElement>("new-maze");
const showSolution = $<HTMLInputElement>("show-solution");
const heatmap = $<HTMLInputElement>("heatmap");
const width = $<HTMLInputElement>("width");
const cell = $<HTMLInputElement>("cell");
const cellLabel = $<HTMLSpanElement>("cell-label");
const wall = $<HTMLInputElement>("wall");
const footprint = $<HTMLParagraphElement>("footprint");
const height = $<HTMLInputElement>("height");
const baseOn = $<HTMLInputElement>("base-on");
const baseFields = $<HTMLDivElement>("base-fields");
const base = $<HTMLInputElement>("base");
const baseMargin = $<HTMLInputElement>("base-margin");
const downloadSvg = $<HTMLButtonElement>("download-svg");
const downloadStl = $<HTMLButtonElement>("download-stl");
const downloadDxf = $<HTMLButtonElement>("download-dxf");
const downloadStep = $<HTMLButtonElement>("download-step");
const statusEl = $<HTMLParagraphElement>("status");
const preview = $<HTMLDivElement>("preview");

const INK = "#000000";
const ROUTE = "#d0306f";
const PAPER = "#ffffff";
const MAX_CELLS = 25000;

for (const [value, { label }] of Object.entries(ALGORITHMS)) {
  algorithm.add(new Option(label, value));
}

// Difficulty -> size. Hexagons and triangles are scaled so a given difficulty
// covers a similar number of decisions as the square grid.
function sizeFor(kind: GridKind, d: number): { cols: number; rows: number } {
  const t = d - 1;
  switch (kind) {
    case "square":
      return { cols: 6 + t * 4, rows: 6 + t * 4 };
    case "round":
      return { cols: 0, rows: 4 + t * 2 };
    case "hex":
      return { cols: 5 + t * 3, rows: 5 + t * 3 };
    case "triangle":
      return { cols: 11 + t * 7, rows: 6 + t * 4 };
  }
}

const CELL_LABELS: Record<GridKind, string> = {
  square: "Cell size",
  round: "Ring width",
  hex: "Hexagon edge",
  triangle: "Triangle edge",
};

const kind = (): GridKind => (new FormData(form).get("kind") as GridKind) ?? "square";
const num = (el: HTMLInputElement, fallback: number) => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const int = (el: HTMLInputElement) => Math.max(2, Math.min(150, Math.round(num(el, 2))));
const randomSeed = () => Math.random().toString(36).slice(2, 8);

let grid: Grid | null = null;
let gridKey = "";
let maze: Maze | null = null;

function syncControls() {
  const k = kind();
  const round = k === "round";
  colsField.hidden = round;
  rowsLabel.textContent = round ? "Rings" : "Rows";
  cellLabel.textContent = CELL_LABELS[k];
  entranceCenter.disabled = !round;
  if (!round && entrance.value === "center") entrance.value = "corners";
  const algo = algorithm.value as Algorithm;
  algorithmNote.textContent = ALGORITHMS[algo].note;
  biasField.hidden = algo !== "growing";
  difficultyOut.value = difficulty.value;
  biasOut.value = bias.value;
  braidOut.value = braid.value;
  baseFields.hidden = !baseOn.checked;
}

function applyDifficulty() {
  const s = sizeFor(kind(), parseInt(difficulty.value, 10));
  if (s.cols) cols.value = String(s.cols);
  rows.value = String(s.rows);
}

/** Grid width in mm per mm of cell size (grids scale linearly from the origin). */
function unitWidth(k: GridKind, c: number, r: number): number {
  switch (k) {
    case "square":
      return c;
    case "round":
      return 2 * r;
    case "hex":
      return Math.sqrt(3) * (c + (r > 1 ? 0.5 : 0));
    case "triangle":
      return (c + 1) / 2;
  }
}

// Width and cell size are linked; whichever was edited last is kept fixed.
let sizeMaster: "width" | "cell" = "width";

function syncSize() {
  const u = unitWidth(kind(), int(cols), int(rows));
  const w = num(wall, 1);
  if (sizeMaster === "width") {
    const c = (num(width, 160) - w) / u;
    cell.value = String(Math.max(0.01, Math.round(c * 1000) / 1000));
  } else {
    width.value = String(Math.round((u * num(cell, 8) + w) * 10) / 10);
  }
}

function spec(): GridSpec {
  return { kind: kind(), cols: int(cols), rows: int(rows), cell: num(cell, 8) };
}

function svgOptions(forPreview: boolean) {
  return {
    wall: num(wall, 1),
    margin: forPreview ? 0 : num(cell, 8) / 2,
    solution: showSolution.checked,
    heatmap: heatmap.checked,
    ink: INK,
    route: ROUTE,
    paper: forPreview ? "" : PAPER,
  };
}

function update(regenerate: boolean) {
  syncControls();
  syncSize();
  const s = spec();
  const key = JSON.stringify(s);
  try {
    if (key !== gridKey || !grid) {
      const probe = buildGrid(s);
      if (probe.centers.length > MAX_CELLS) {
        statusEl.dataset.kind = "error";
        statusEl.textContent = `That is ${probe.centers.length.toLocaleString()} cells; the limit is ${MAX_CELLS.toLocaleString()}.`;
        return;
      }
      grid = probe;
      gridKey = key;
      regenerate = true;
    }
    if (regenerate || !maze) {
      maze = generate(grid, {
        algorithm: algorithm.value as Algorithm,
        bias: parseInt(bias.value, 10) / 100,
        braid: parseInt(braid.value, 10) / 100,
        entrance: entrance.value as Entrance,
        seed: seed.value,
      });
    }
  } catch (err) {
    statusEl.dataset.kind = "error";
    statusEl.textContent = err instanceof Error ? err.message : String(err);
    return;
  }

  preview.innerHTML = renderSvg(maze, svgOptions(true));

  const n = grid.centers.length;
  statusEl.dataset.kind = "idle";
  statusEl.textContent =
    `${n.toLocaleString()} cells · solution ${maze.solution.length.toLocaleString()} cells ` +
    `(${Math.round((100 * maze.solution.length) / n)}% of the maze) · ${maze.deadEnds.toLocaleString()} dead ends`;

  const { minX, minY, maxX, maxY } = grid.bounds;
  const w = num(wall, 1);
  const pad = baseOn.checked ? 2 * num(baseMargin, 0) : 0;
  const mm = (v: number) => `${Math.round((v + w + pad) * 10) / 10}`;
  footprint.textContent =
    `Maze ${mm(maxX - minX - pad)} × ${mm(maxY - minY - pad)} mm` +
    (baseOn.checked ? ` · plate ${mm(maxX - minX)} × ${mm(maxY - minY)} mm` : "");
  if (w >= num(cell, 8) * 0.6) footprint.textContent += " · walls nearly fill the cells";

  saveState();
}

function fileStem(): string {
  const s = spec();
  const size = s.kind === "round" ? `${s.rows}rings` : `${s.cols}x${s.rows}`;
  const safeSeed = seed.value.replace(/[^\w-]+/g, "_").slice(0, 32) || "maze";
  return `maze-${s.kind}-${size}-${safeSeed}`;
}

function download(data: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// State lives in the URL hash so a maze can be bookmarked or shared.
const STATE_FIELDS: (HTMLInputElement | HTMLSelectElement)[] = [
  difficulty,
  cols,
  width,
  rows,
  algorithm,
  bias,
  braid,
  entrance,
  seed,
  cell,
  wall,
  height,
  base,
  baseMargin,
];
const STATE_CHECKS = [showSolution, heatmap, baseOn];

function saveState() {
  const p = new URLSearchParams();
  p.set("kind", kind());
  for (const el of STATE_FIELDS) p.set(el.id, el.value);
  for (const el of STATE_CHECKS) p.set(el.id, el.checked ? "1" : "0");
  p.set("size", sizeMaster);
  history.replaceState(null, "", `#${p}`);
}

function loadState(): boolean {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has("seed")) return false;
  const k = p.get("kind");
  const radio = form.querySelector<HTMLInputElement>(`input[name="kind"][value="${CSS.escape(k ?? "")}"]`);
  if (radio) radio.checked = true;
  for (const el of STATE_FIELDS) {
    const v = p.get(el.id);
    if (v === null) continue;
    if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === v)) continue;
    el.value = v;
  }
  for (const el of STATE_CHECKS) {
    const v = p.get(el.id);
    if (v !== null) el.checked = v === "1";
  }
  if (p.get("size") === "cell") sizeMaster = "cell";
  return true;
}

// Events ---------------------------------------------------------------------

form.addEventListener("submit", (e) => e.preventDefault());

form.addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
  if (t === width) sizeMaster = "width";
  if (t === cell) sizeMaster = "cell";
  if (t === difficulty) applyDifficulty();
  if (t instanceof HTMLInputElement && t.name === "kind") applyDifficulty();
  // Display-only changes re-render without generating a new maze.
  const displayOnly = [showSolution, heatmap, wall, height, base, baseMargin, baseOn].includes(t as HTMLInputElement);
  update(!displayOnly);
});

newMaze.addEventListener("click", () => {
  seed.value = randomSeed();
  update(true);
});

downloadSvg.addEventListener("click", () => {
  if (!maze) return;
  download(renderSvg(maze, svgOptions(false)), "image/svg+xml", `${fileStem()}.svg`);
});

function solidOptions() {
  return {
    wall: num(wall, 1),
    height: num(height, 6),
    base: baseOn.checked ? num(base, 1.6) : 0,
    margin: Math.max(0, parseFloat(baseMargin.value) || 0),
  };
}

// CAD exports pull in the polygon-union library, so load them on first use.
downloadDxf.addEventListener("click", async () => {
  if (!maze) return;
  const { encodeDxf } = await import("./dxf");
  download(encodeDxf(maze, num(wall, 1)), "image/vnd.dxf", `${fileStem()}.dxf`);
});

downloadStep.addEventListener("click", async () => {
  if (!maze) return;
  const [{ buildModel }, { encodeStep }] = await Promise.all([import("./solid"), import("./step")]);
  const name = fileStem();
  download(encodeStep(buildModel(maze, solidOptions()), name), "model/step", `${name}.step`);
});

downloadStl.addEventListener("click", async () => {
  if (!maze) return;
  const [{ buildModel }, { encodeStl }] = await Promise.all([import("./solid"), import("./stl")]);
  download(encodeStl(buildModel(maze, solidOptions())), "model/stl", `${fileStem()}.stl`);
});

if (!loadState()) {
  seed.value = randomSeed();
  applyDifficulty();
}
update(true);
