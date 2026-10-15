// Grid topologies. Every grid is reduced to the same shape: a list of cells and
// a list of walls, where each wall separates two cells (or one cell from the
// outside). Generation carves passages by removing interior walls; rendering
// and 3D export draw whatever walls are left. Units are millimetres throughout.

export type GridKind = "square" | "round" | "hex" | "triangle";

export interface Line {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Arc around (cx, cy) from angle a0 to a1 (radians, a0 < a1, increasing angle). */
export interface Arc {
  kind: "arc";
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
}

export type WallGeom = Line | Arc;

export interface Wall {
  a: number;
  /** Neighbouring cell, or -1 for an outer boundary wall. */
  b: number;
  geom: WallGeom;
}

export interface Point {
  x: number;
  y: number;
}

export interface Grid {
  kind: GridKind;
  /** Visual centre of each cell (used to draw the solution path). */
  centers: Point[];
  /** Outline of each cell as an SVG path `d` (used for distance colouring). */
  shapes: string[];
  walls: Wall[];
  /** Wall indices touching each cell. */
  cellWalls: number[][];
  /** Index of the centre cell for round grids, else -1. */
  hub: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface GridSpec {
  kind: GridKind;
  /** Columns (square, hex, triangle) — ignored for round. */
  cols: number;
  /** Rows (square, hex, triangle) or rings (round). */
  rows: number;
  /** Cell size in mm (edge length for hex/triangle, ring depth for round). */
  cell: number;
}

export function buildGrid(spec: GridSpec): Grid {
  switch (spec.kind) {
    case "square":
      return polygonGrid("square", squareCells(spec));
    case "hex":
      return polygonGrid("hex", hexCells(spec));
    case "triangle":
      return polygonGrid("triangle", triangleCells(spec));
    case "round":
      return roundGrid(spec);
  }
}

export function wallMidpoint(g: WallGeom): Point {
  if (g.kind === "line") return { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 };
  const a = (g.a0 + g.a1) / 2;
  return { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) };
}

export function wallEndpoints(g: WallGeom): [Point, Point] {
  if (g.kind === "line") {
    return [
      { x: g.x1, y: g.y1 },
      { x: g.x2, y: g.y2 },
    ];
  }
  return [
    { x: g.cx + g.r * Math.cos(g.a0), y: g.cy + g.r * Math.sin(g.a0) },
    { x: g.cx + g.r * Math.cos(g.a1), y: g.cy + g.r * Math.sin(g.a1) },
  ];
}

// Polygon grids ----------------------------------------------------------

/** Build walls for any tiling of polygons by matching shared edges. */
function polygonGrid(kind: GridKind, polys: Point[][]): Grid {
  const walls: Wall[] = [];
  const cellWalls: number[][] = polys.map(() => []);
  const byEdge = new Map<string, number>();
  const key = (p: Point) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  polys.forEach((poly, c) => {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      const kp = key(p);
      const kq = key(q);
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const existing = byEdge.get(k);
      if (existing !== undefined) {
        walls[existing].b = c;
        cellWalls[c].push(existing);
      } else {
        const w = walls.length;
        walls.push({ a: c, b: -1, geom: { kind: "line", x1: p.x, y1: p.y, x2: q.x, y2: q.y } });
        byEdge.set(k, w);
        cellWalls[c].push(w);
      }
    }
  });

  const centers = polys.map((poly) => {
    let x = 0,
      y = 0;
    for (const p of poly) {
      x += p.x;
      y += p.y;
    }
    return { x: x / poly.length, y: y / poly.length };
  });
  const shapes = polys.map((poly) => "M" + poly.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join("L") + "Z");

  return { kind, centers, shapes, walls, cellWalls, hub: -1, bounds: { minX, minY, maxX, maxY } };
}

function squareCells({ cols, rows, cell: s }: GridSpec): Point[][] {
  const out: Point[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * s;
      const y = r * s;
      out.push([
        { x, y },
        { x: x + s, y },
        { x: x + s, y: y + s },
        { x, y: y + s },
      ]);
    }
  }
  return out;
}

/** Pointy-topped hexagons in offset rows (odd rows shifted right). */
function hexCells({ cols, rows, cell: s }: GridSpec): Point[][] {
  const w = Math.sqrt(3) * s;
  const out: Point[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = w / 2 + c * w + (r & 1 ? w / 2 : 0);
      const cy = s + r * 1.5 * s;
      const poly: Point[] = [];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k - 90);
        poly.push({ x: cx + s * Math.cos(a), y: cy + s * Math.sin(a) });
      }
      out.push(poly);
    }
  }
  return out;
}

/** Alternating up/down equilateral triangles. */
function triangleCells({ cols, rows, cell: s }: GridSpec): Point[][] {
  const h = (Math.sqrt(3) / 2) * s;
  const out: Point[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c * s) / 2;
      const y = r * h;
      const up = (r + c) % 2 === 0;
      out.push(
        up
          ? [
              { x, y: y + h },
              { x: x + s / 2, y },
              { x: x + s, y: y + h },
            ]
          : [
              { x, y },
              { x: x + s, y },
              { x: x + s / 2, y: y + h },
            ],
      );
    }
  }
  return out;
}

// Round (polar) grid ------------------------------------------------------

/**
 * Concentric rings around a single hub cell. Each ring is split into as many
 * cells as keep them roughly square; a ring's count is always a multiple of
 * the ring inside it, so every outer cell has exactly one inward neighbour.
 */
function roundGrid({ rows: rings, cell: h }: GridSpec): Grid {
  const R = rings * h;
  const cx = R;
  const cy = R;
  const counts = [1];
  for (let i = 1; i < rings; i++) {
    const prev = counts[i - 1];
    const ratio = Math.max(1, Math.round((2 * Math.PI * i) / prev));
    counts.push(prev * ratio);
  }
  const first: number[] = [];
  let total = 0;
  for (const n of counts) {
    first.push(total);
    total += n;
  }

  const centers: Point[] = [];
  const shapes: string[] = [];
  const walls: Wall[] = [];
  const cellWalls: number[][] = Array.from({ length: total }, () => []);
  const add = (a: number, b: number, geom: WallGeom) => {
    const w = walls.length;
    walls.push({ a, b, geom });
    cellWalls[a].push(w);
    if (b >= 0) cellWalls[b].push(w);
  };
  const pt = (r: number, a: number) => `${fmt(cx + r * Math.cos(a))} ${fmt(cy + r * Math.sin(a))}`;

  centers.push({ x: cx, y: cy });
  shapes.push(`M${pt(h, 0)}A${fmt(h)} ${fmt(h)} 0 1 1 ${pt(h, Math.PI)}A${fmt(h)} ${fmt(h)} 0 1 1 ${pt(h, 0)}Z`);

  for (let i = 1; i < rings; i++) {
    const n = counts[i];
    const step = (2 * Math.PI) / n;
    const r0 = i * h;
    const r1 = (i + 1) * h;
    const ratio = n / counts[i - 1];
    for (let j = 0; j < n; j++) {
      const c = first[i] + j;
      const a0 = j * step;
      const a1 = (j + 1) * step;
      const am = (a0 + a1) / 2;
      const rm = (r0 + r1) / 2;
      centers.push({ x: cx + rm * Math.cos(am), y: cy + rm * Math.sin(am) });
      const large = step > Math.PI ? 1 : 0;
      shapes.push(
        `M${pt(r0, a0)}L${pt(r1, a0)}A${fmt(r1)} ${fmt(r1)} 0 ${large} 1 ${pt(r1, a1)}` +
          `L${pt(r0, a1)}A${fmt(r0)} ${fmt(r0)} 0 ${large} 0 ${pt(r0, a0)}Z`,
      );
      // Inward arc, shared with the parent cell in the ring inside.
      const parent = first[i - 1] + Math.floor(j / ratio);
      add(c, parent, { kind: "arc", cx, cy, r: r0, a0, a1 });
      // Radial wall to the clockwise neighbour (skip when a ring has one cell).
      if (n > 1) {
        const next = first[i] + ((j + 1) % n);
        const x1 = cx + r0 * Math.cos(a1);
        const y1 = cy + r0 * Math.sin(a1);
        const x2 = cx + r1 * Math.cos(a1);
        const y2 = cy + r1 * Math.sin(a1);
        add(c, next, { kind: "line", x1, y1, x2, y2 });
      }
      // Outer boundary.
      if (i === rings - 1) add(c, -1, { kind: "arc", cx, cy, r: r1, a0, a1 });
    }
  }

  return {
    kind: "round",
    centers,
    shapes,
    walls,
    cellWalls,
    hub: 0,
    bounds: { minX: 0, minY: 0, maxX: 2 * R, maxY: 2 * R },
  };
}

export function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}
