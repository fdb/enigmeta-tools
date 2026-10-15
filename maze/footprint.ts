// The maze's walls as clean 2D outlines: every wall becomes a slab of the wall
// width, every wall end a post, and the lot is unioned into simple polygons
// (with holes, if any). This one footprint feeds the DXF, STEP and STL exports,
// so they all describe the same geometry.
//
// Coordinates here are model space: millimetres, y up (the SVG grid is y down,
// so y is mirrored about the grid's vertical centre).

import ClipperLib from "clipper-lib";
import type { Path, PolyNode } from "clipper-lib";
import type { Maze } from "./generate";
import type { Point } from "./grid";
import { wallEndpoints } from "./grid";

/** Largest gap allowed between a true arc and its straight segments, in mm. */
export const ARC_TOLERANCE = 0.02;

/** A filled region: outer ring counter-clockwise, hole rings clockwise. */
export interface Shape {
  outer: Point[];
  holes: { ring: Point[]; islands: Shape[] }[];
}

const SCALE = 1000; // Clipper works in integers: 1 unit = 1 µm.

export function arcSegments(r: number, span: number): number {
  if (r <= ARC_TOLERANCE) return 3;
  const step = 2 * Math.acos(1 - ARC_TOLERANCE / r);
  return Math.max(2, Math.ceil(span / step));
}

export function signedArea(ring: Point[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

const orient = (ring: Point[], ccw: boolean) => (signedArea(ring) > 0 === ccw ? ring : [...ring].reverse());

export function circle(c: Point, r: number, minSegments = 12): Point[] {
  const n = Math.max(minSegments, arcSegments(r, 2 * Math.PI));
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

/** Mirror from SVG (y down) into model space (y up). */
export function toModel(maze: Maze) {
  const { minY, maxY } = maze.grid.bounds;
  return (p: Point): Point => ({ x: p.x, y: minY + maxY - p.y });
}

export function wallFootprint(maze: Maze, wall: number): Shape[] {
  const g = maze.grid;
  const hw = wall / 2;
  const flip = toModel(maze);
  const pieces: Point[][] = [];
  const posts = new Map<string, Point>();
  const addPost = (p: Point) => posts.set(`${Math.round(p.x * SCALE)},${Math.round(p.y * SCALE)}`, p);

  g.walls.forEach((w, i) => {
    if (maze.open[i]) return;
    const geom = w.geom;
    const [p, q] = wallEndpoints(geom);
    addPost(p);
    addPost(q);
    if (geom.kind === "line") {
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const nx = (-(q.y - p.y) / len) * hw;
      const ny = ((q.x - p.x) / len) * hw;
      pieces.push([
        { x: p.x - nx, y: p.y - ny },
        { x: q.x - nx, y: q.y - ny },
        { x: q.x + nx, y: q.y + ny },
        { x: p.x + nx, y: p.y + ny },
      ]);
      return;
    }
    const r0 = Math.max(0, geom.r - hw);
    const r1 = geom.r + hw;
    const n = arcSegments(r1, geom.a1 - geom.a0);
    const outer: Point[] = [];
    const inner: Point[] = [];
    for (let k = 0; k <= n; k++) {
      const a = geom.a0 + ((geom.a1 - geom.a0) * k) / n;
      outer.push({ x: geom.cx + r1 * Math.cos(a), y: geom.cy + r1 * Math.sin(a) });
      inner.push({ x: geom.cx + r0 * Math.cos(a), y: geom.cy + r0 * Math.sin(a) });
    }
    pieces.push([...outer, ...inner.reverse()]);
  });

  for (const p of posts.values()) {
    pieces.push(
      g.kind === "square"
        ? [
            { x: p.x - hw, y: p.y - hw },
            { x: p.x + hw, y: p.y - hw },
            { x: p.x + hw, y: p.y + hw },
            { x: p.x - hw, y: p.y + hw },
          ]
        : circle(p, hw),
    );
  }

  // Same orientation for every piece, or non-zero filling would cancel overlaps.
  const paths: Path[] = pieces.map((piece) =>
    orient(piece.map(flip), true).map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })),
  );
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );

  const ring = (path: Path, ccw: boolean): Point[] | null => {
    const clean = ClipperLib.Clipper.CleanPolygon(path, 1.5);
    if (clean.length < 3) return null;
    return orient(
      clean.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE })),
      ccw,
    );
  };
  const shapes = (nodes: PolyNode[]): Shape[] => {
    const out: Shape[] = [];
    for (const node of nodes) {
      const outer = ring(node.Contour(), true);
      if (!outer) continue;
      const holes: Shape["holes"] = [];
      for (const h of node.Childs()) {
        const hr = ring(h.Contour(), false);
        if (hr) holes.push({ ring: hr, islands: shapes(h.Childs()) });
      }
      out.push({ outer, holes });
    }
    return out;
  };
  return shapes(tree.Childs());
}

/** Outline of the ground plate in model space, counter-clockwise. */
export function baseOutline(maze: Maze, wall: number, margin: number): Point[] {
  const { minX, minY, maxX, maxY } = maze.grid.bounds;
  const m = margin + wall / 2;
  if (maze.grid.kind === "round") {
    // Mirroring a circle about the grid centre leaves it in place.
    return circle({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, (maxX - minX) / 2 + m, 64);
  }
  return [
    { x: minX - m, y: minY - m },
    { x: maxX + m, y: minY - m },
    { x: maxX + m, y: maxY + m },
    { x: minX - m, y: maxY + m },
  ];
}
