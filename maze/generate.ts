// Maze generation on any Grid: carve a spanning tree (a "perfect" maze with
// exactly one route between any two cells), optionally add loops, pick the
// entrance and exit, and solve it.

import type { Grid, Line, Point, WallGeom } from "./grid";
import { wallMidpoint } from "./grid";

export type Algorithm = "backtracker" | "growing" | "prim" | "kruskal" | "wilson" | "hunt";

export const ALGORITHMS: Record<Algorithm, { label: string; note: string }> = {
  backtracker: {
    label: "Recursive backtracker",
    note: "Long, twisting corridors and few dead ends. The classic look.",
  },
  growing: {
    label: "Growing tree",
    note: "Blends backtracker and Prim's: the bias slider sets corridors versus branching.",
  },
  prim: {
    label: "Prim's",
    note: "Many short dead ends radiating out. Busy, but the route is often direct.",
  },
  kruskal: {
    label: "Kruskal's",
    note: "Joins random pieces together; lots of short dead ends, no overall direction.",
  },
  wilson: {
    label: "Wilson's",
    note: "Uniform: every possible perfect maze is equally likely. No stylistic bias.",
  },
  hunt: {
    label: "Hunt-and-kill",
    note: "Like the backtracker, with long corridors, but a little more branching.",
  },
};

export type Entrance = "corners" | "longest" | "center";

export interface MazeOptions {
  algorithm: Algorithm;
  /** Growing tree only: 0 = always pick a random cell (Prim-like), 1 = always the newest (backtracker). */
  bias: number;
  /** Fraction of dead ends to knock through (0 = perfect maze, 1 = no dead ends). */
  braid: number;
  entrance: Entrance;
  seed: string;
}

export interface Maze {
  grid: Grid;
  /** Per wall: true when carved open. */
  open: boolean[];
  start: number;
  end: number;
  /** Boundary walls opened as entrance and exit (-1 when the start is the hub). */
  doors: number[];
  /** Cells on the solution, start to end. */
  solution: number[];
  /** Points to draw the solution through: cell centres and the walls between them. */
  path: Point[];
  /** Steps from the start to every cell. */
  distance: number[];
  deadEnds: number;
  /** Walls outside the grid, such as a ball storage alcove. */
  extra: Line[];
}

/** Every wall still standing: closed grid walls plus any extras. */
export function standingWalls(maze: Maze): WallGeom[] {
  const out: WallGeom[] = maze.grid.walls.filter((_, i) => !maze.open[i]).map((w) => w.geom);
  return out.concat(maze.extra);
}

/** Bounds of the grid and any extra walls (centre lines, in SVG coordinates). */
export function mazeBounds(maze: Maze) {
  let { minX, minY, maxX, maxY } = maze.grid.bounds;
  for (const l of maze.extra) {
    minX = Math.min(minX, l.x1, l.x2);
    maxX = Math.max(maxX, l.x1, l.x2);
    minY = Math.min(minY, l.y1, l.y2);
    maxY = Math.max(maxY, l.y1, l.y2);
  }
  return { minX, minY, maxX, maxY };
}

// Seeded RNG ----------------------------------------------------------------

export type Rng = () => number;

export function rngFromSeed(seed: string): Rng {
  // FNV-1a to a 32-bit state, then mulberry32.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, xs: T[]): T => xs[Math.floor(rng() * xs.length)];

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

// Graph helpers --------------------------------------------------------------

/** Interior neighbours of a cell as [cell, wall] pairs. */
function links(g: Grid, c: number): [number, number][] {
  const out: [number, number][] = [];
  for (const w of g.cellWalls[c]) {
    const { a, b } = g.walls[w];
    if (b < 0) continue;
    out.push([a === c ? b : a, w]);
  }
  return out;
}

function openLinks(g: Grid, open: boolean[], c: number): [number, number][] {
  return links(g, c).filter(([, w]) => open[w]);
}

// Algorithms -----------------------------------------------------------------

function carve(g: Grid, opts: MazeOptions, rng: Rng): boolean[] {
  const n = g.centers.length;
  const open = new Array<boolean>(g.walls.length).fill(false);
  const visited = new Uint8Array(n);
  const unvisitedLinks = (c: number) => links(g, c).filter(([o]) => !visited[o]);

  switch (opts.algorithm) {
    case "backtracker":
    case "growing": {
      // Growing tree; the backtracker is the "always newest" special case.
      const newest = opts.algorithm === "backtracker" ? 1 : opts.bias;
      const active: number[] = [Math.floor(rng() * n)];
      visited[active[0]] = 1;
      while (active.length) {
        const idx = rng() < newest ? active.length - 1 : Math.floor(rng() * active.length);
        const c = active[idx];
        const nb = unvisitedLinks(c);
        if (!nb.length) {
          active.splice(idx, 1);
          continue;
        }
        const [o, w] = pick(rng, nb);
        open[w] = true;
        visited[o] = 1;
        active.push(o);
      }
      break;
    }
    case "prim": {
      // Randomised Prim's over walls: grow from one cell by opening a random frontier wall.
      const start = Math.floor(rng() * n);
      visited[start] = 1;
      const frontier = links(g, start).map(([, w]) => w);
      while (frontier.length) {
        const i = Math.floor(rng() * frontier.length);
        const w = frontier[i];
        frontier[i] = frontier[frontier.length - 1];
        frontier.pop();
        const { a, b } = g.walls[w];
        const o = visited[a] ? (visited[b] ? -1 : b) : a;
        if (o < 0) continue;
        open[w] = true;
        visited[o] = 1;
        for (const [nb, nw] of links(g, o)) if (!visited[nb]) frontier.push(nw);
      }
      break;
    }
    case "kruskal": {
      const parent = Array.from({ length: n }, (_, i) => i);
      const find = (x: number): number => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const interior = g.walls.map((_, i) => i).filter((i) => g.walls[i].b >= 0);
      for (const w of shuffle(rng, interior)) {
        const ra = find(g.walls[w].a);
        const rb = find(g.walls[w].b);
        if (ra !== rb) {
          parent[ra] = rb;
          open[w] = true;
        }
      }
      break;
    }
    case "wilson": {
      // Loop-erased random walks from each unvisited cell until they hit the tree.
      const next = new Int32Array(n).fill(-1);
      const via = new Int32Array(n).fill(-1);
      visited[Math.floor(rng() * n)] = 1;
      const order = shuffle(
        rng,
        Array.from({ length: n }, (_, i) => i),
      );
      for (const s of order) {
        if (visited[s]) continue;
        let c = s;
        while (!visited[c]) {
          const [o, w] = pick(rng, links(g, c));
          next[c] = o; // overwriting erases loops
          via[c] = w;
          c = o;
        }
        for (c = s; !visited[c]; c = next[c]) {
          visited[c] = 1;
          open[via[c]] = true;
        }
      }
      break;
    }
    case "hunt": {
      let c = Math.floor(rng() * n);
      visited[c] = 1;
      let remaining = n - 1;
      while (remaining > 0) {
        const nb = unvisitedLinks(c);
        if (nb.length) {
          const [o, w] = pick(rng, nb);
          open[w] = true;
          visited[o] = 1;
          remaining--;
          c = o;
          continue;
        }
        // Hunt: the first unvisited cell bordering the carved region.
        c = -1;
        for (let k = 0; k < n && c < 0; k++) {
          if (visited[k]) continue;
          const vk = links(g, k).filter(([o]) => visited[o]);
          if (!vk.length) continue;
          open[pick(rng, vk)[1]] = true;
          visited[k] = 1;
          remaining--;
          c = k;
        }
        if (c < 0) throw new Error("hunt-and-kill: grid is disconnected");
      }
      break;
    }
  }
  return open;
}

/** Knock through a fraction of dead ends, preferring to join two dead ends. */
function braid(g: Grid, open: boolean[], fraction: number, rng: Rng) {
  if (fraction <= 0) return;
  const cells = shuffle(
    rng,
    g.centers.map((_, i) => i),
  );
  for (const c of cells) {
    if (openLinks(g, open, c).length !== 1 || rng() >= fraction) continue;
    const closed = links(g, c).filter(([, w]) => !open[w]);
    if (!closed.length) continue;
    const deadNeighbours = closed.filter(([o]) => openLinks(g, open, o).length === 1);
    const [, w] = pick(rng, deadNeighbours.length ? deadNeighbours : closed);
    open[w] = true;
  }
}

/** Breadth-first distances and predecessors from `from`. */
function bfs(g: Grid, open: boolean[], from: number) {
  const n = g.centers.length;
  const dist = new Array<number>(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  dist[from] = 0;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (const [o] of openLinks(g, open, c)) {
      if (dist[o] >= 0) continue;
      dist[o] = dist[c] + 1;
      prev[o] = c;
      queue.push(o);
    }
  }
  return { dist, prev };
}

function boundaryWalls(g: Grid, c: number): number[] {
  return g.cellWalls[c].filter((w) => g.walls[w].b < 0);
}

function pickEnds(g: Grid, open: boolean[], mode: Entrance): [number, number] {
  const boundary = g.centers.map((_, i) => i).filter((i) => boundaryWalls(g, i).length > 0);
  const farthest = (from: number) => {
    const { dist } = bfs(g, open, from);
    return boundary.reduce((best, c) => (dist[c] > dist[best] ? c : best), boundary[0]);
  };
  if (mode === "center" && g.hub >= 0) return [g.hub, farthest(g.hub)];
  if (mode === "longest") {
    const a = farthest(boundary[0]);
    return [a, farthest(a)];
  }
  // Opposite corners (or, on a round maze, opposite sides).
  const score = (c: number) => g.centers[c].x + (g.kind === "round" ? 0 : g.centers[c].y);
  let a = boundary[0];
  let b = boundary[0];
  for (const c of boundary) {
    if (score(c) < score(a)) a = c;
    if (score(c) > score(b)) b = c;
  }
  return [a, b];
}

/** The outer wall of `c` that faces most directly away from the maze. */
function doorFor(g: Grid, c: number, preferTop: boolean): number {
  const { minX, minY, maxX, maxY } = g.bounds;
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  let best = -1;
  let bestScore = -Infinity;
  for (const w of boundaryWalls(g, c)) {
    const p = wallMidpoint(g.walls[w].geom);
    const s = Math.hypot(p.x - mx, p.y - my) + (preferTop ? -p.y : p.y) * 1e-6;
    if (s > bestScore + 1e-9) {
      best = w;
      bestScore = s;
    }
  }
  return best;
}

export function generate(g: Grid, opts: MazeOptions): Maze {
  const rng = rngFromSeed(opts.seed);
  const open = carve(g, opts, rng);
  braid(g, open, opts.braid, rng);

  const [start, end] = pickEnds(g, open, opts.entrance);
  const doors = [start === g.hub ? -1 : doorFor(g, start, true), doorFor(g, end, false)];

  const { dist, prev } = bfs(g, open, start);
  const solution: number[] = [];
  for (let c = end; c >= 0; c = prev[c]) solution.push(c);
  solution.reverse();

  const path: Point[] = [];
  if (doors[0] >= 0) path.push(wallMidpoint(g.walls[doors[0]].geom));
  for (let i = 0; i < solution.length; i++) {
    const c = solution[i];
    path.push(g.centers[c]);
    const nextCell = solution[i + 1];
    if (nextCell === undefined) break;
    const w = openLinks(g, open, c).find(([o]) => o === nextCell)![1];
    path.push(wallMidpoint(g.walls[w].geom));
  }
  path.push(wallMidpoint(g.walls[doors[1]].geom));

  for (const d of doors) if (d >= 0) open[d] = true;

  let deadEnds = 0;
  for (let c = 0; c < g.centers.length; c++) {
    if (c !== start && c !== end && openLinks(g, open, c).length === 1) deadEnds++;
  }

  return { grid: g, open, start, end, doors, solution, path, distance: dist, deadEnds, extra: [] };
}
