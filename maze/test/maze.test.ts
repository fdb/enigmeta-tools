// Development checks for maze generation and export. Run:
//   node_modules/.bin/esbuild maze/test/maze.test.ts --bundle --format=esm \
//     --platform=node --outfile=/tmp/maze.mjs && node /tmp/maze.mjs
import { buildGrid } from "../grid";
import type { GridKind } from "../grid";
import { ALGORITHMS, generate } from "../generate";
import type { Algorithm, Entrance } from "../generate";
import { renderSvg } from "../svg";
import { buildStl } from "../stl";

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

  // STL: well-formed size, finite numbers, and positive enclosed volume
  // (inside-out solids would subtract).
  for (const base of [0, 2]) {
    const buf = buildStl(m, { wall: 1.2, height: 8, base, margin: 3 });
    const dv = new DataView(buf);
    const count = dv.getUint32(80, true);
    check(`${kind} stl size`, buf.byteLength === 84 + 50 * count);
    let vol = 0;
    let finite = true;
    for (let t = 0; t < count; t++) {
      const o = 84 + 50 * t + 12;
      const p = [0, 1, 2].map((k) => [0, 1, 2].map((j) => dv.getFloat32(o + 12 * k + 4 * j, true)));
      for (const q of p) for (const x of q) if (!Number.isFinite(x)) finite = false;
      const [a, b, c] = p;
      vol +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
    check(`${kind} stl finite`, finite);
    check(`${kind} stl volume`, vol > 0, `vol=${vol}`);
    console.log(`${kind} base=${base}: ${n} cells, ${count} triangles, ${vol.toFixed(0)} mm³ (overlaps counted twice)`);
  }
}

if (failures) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log("PASS: all maze checks");
