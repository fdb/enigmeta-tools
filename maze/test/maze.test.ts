// Development checks for maze generation and export. Run:
//   node_modules/.bin/esbuild maze/test/maze.test.ts --bundle --format=esm \
//     --platform=node --outfile=/tmp/maze.mjs && node /tmp/maze.mjs [out-dir]
// With an out-dir, sample STEP/STL/DXF files are written there for checking
// in a CAD kernel (see validate_step.py).
import { buildGrid } from "../grid";
import type { GridKind } from "../grid";
import { ALGORITHMS, generate } from "../generate";
import type { Algorithm, Entrance } from "../generate";
import { renderSvg } from "../svg";
import { buildModel } from "../solid";
import { encodeStl, triangulate } from "../stl";
import { encodeStep } from "../step";
import { encodeDxf } from "../dxf";
import { writeFileSync } from "node:fs";

const outDir = process.argv[2];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
}

const kinds: GridKind[] = ["square", "round", "hex", "triangle"];
const algos = Object.keys(ALGORITHMS) as Algorithm[];
const entrances: Entrance[] = ["corners", "longest", "center"];

for (const kind of kinds) {
  const grid = buildGrid({ kind, cols: 13, rows: 9, cell: 5 });
  const n = grid.centers.length;
  for (const algorithm of algos) {
    for (const entrance of entrances) {
      for (const braid of [0, 0.5]) {
        for (const seed of ["a", "b", "c"]) {
          const name = `${kind}/${algorithm}/${entrance}/braid=${braid}/${seed}`;
          const m = generate(grid, { algorithm, bias: 0.5, braid, entrance, seed });
          const interiorOpen = grid.walls.filter((w, i) => w.b >= 0 && m.open[i]).length;
          if (braid === 0) check(`${name} spanning tree`, interiorOpen === n - 1, `${interiorOpen} vs ${n - 1}`);
          check(
            `${name} all reachable`,
            m.distance.every((d) => d >= 0),
          );
          check(`${name} start != end`, m.start !== m.end);
          check(`${name} solution ends`, m.solution[0] === m.start && m.solution.at(-1) === m.end);
          check(
            `${name} doors open`,
            m.doors.every((d) => d < 0 || (grid.walls[d].b < 0 && m.open[d])),
          );
          check(`${name} solution length`, m.solution.length === m.distance[m.end] + 1);
          const again = generate(grid, { algorithm, bias: 0.5, braid, entrance, seed });
          check(`${name} deterministic`, again.open.join() === m.open.join());
        }
      }
    }
  }
  const m = generate(grid, { algorithm: "backtracker", bias: 1, braid: 0, entrance: "longest", seed: "x" });
  const svg = renderSvg(m, {
    wall: 1,
    margin: 2,
    solution: true,
    heatmap: true,
    ink: "#000",
    route: "#c00",
    paper: "#fff",
  });
  check(`${kind} svg`, svg.startsWith("<svg") && svg.endsWith("</svg>") && !svg.includes("NaN"));

  // Solid: every body watertight (each directed triangle edge matched by its
  // reverse exactly once) with positive volume; STL and STEP well-formed.
  for (const base of [0, 2]) {
    const model = buildModel(m, { wall: 1.2, height: 8, base, margin: 3 });
    const tris = triangulate(model);
    const edges = new Map<string, number>();
    const key = (a: number[], b: number[]) => `${a.join()}|${b.join()}`;
    let vol = 0;
    for (const [a, b, c] of tris) {
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ])
        edges.set(key(p, q), (edges.get(key(p, q)) ?? 0) + 1);
      vol +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
    let unmatched = 0;
    for (const [k, n] of edges) {
      const [p, q] = k.split("|");
      if (n !== 1 || edges.get(`${q}|${p}`) !== 1) unmatched++;
    }
    check(`${kind} base=${base} watertight`, unmatched === 0, `${unmatched} unmatched edges`);
    check(`${kind} base=${base} volume`, vol > 0, `vol=${vol}`);
    const stl = encodeStl(model);
    check(`${kind} stl size`, stl.byteLength === 84 + 50 * tris.length);
    const step = encodeStep(model, `maze-${kind}`);
    check(`${kind} step`, step.startsWith("ISO-10303-21;") && !step.includes("NaN"));
    const dxf = encodeDxf(m, 1.2);
    check(`${kind} dxf`, dxf.includes("WALLS") && dxf.trimEnd().endsWith("EOF") && !dxf.includes("NaN"));
    if (outDir) {
      writeFileSync(`${outDir}/${kind}-base${base}.step`, step);
      writeFileSync(`${outDir}/${kind}-base${base}.stl`, new Uint8Array(stl));
      writeFileSync(`${outDir}/${kind}.dxf`, dxf);
    }
    console.log(
      `${kind} base=${base}: ${n} cells, ${model.bodies.length} bodies, ${tris.length} triangles, ${vol.toFixed(0)} mm³`,
    );
  }
}

if (failures) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log("PASS: all maze checks");
