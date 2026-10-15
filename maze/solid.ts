// The 3D maze as a polyhedral boundary representation: shared vertices,
// planar faces (outer loop plus hole loops), grouped into closed bodies. The
// STL and STEP exports are both written from this, so they are watertight
// and describe the same solid.

import ClipperLib from "clipper-lib";
import type { Path, PolyNode } from "clipper-lib";
import type { Maze } from "./generate";
import type { Point } from "./grid";
import type { Shape } from "./footprint";
import { baseOutline, signedArea, wallFootprint } from "./footprint";

export type V3 = [number, number, number];

export interface Face {
  /** Vertex indices; loops[0] is the outer boundary, the rest are holes. Counter-clockwise seen from outside. */
  loops: number[][];
}

export interface Model {
  verts: V3[];
  bodies: Face[][];
}

export interface SolidOptions {
  /** Wall thickness in mm. */
  wall: number;
  /** Wall height above the ground plate (or above z = 0 without one) in mm. */
  height: number;
  /** Ground plate thickness in mm; 0 for none. */
  base: number;
  /** How far the ground plate extends past the outer walls, in mm. */
  margin: number;
}

/** Smallest plate border that still leaves the walls strictly inside the plate. */
export const MIN_MARGIN = 0.2;

export function buildModel(maze: Maze, o: SolidOptions): Model {
  const verts: V3[] = [];
  const index = new Map<string, number>();
  const vid = (p: Point, z: number) => {
    const k = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)},${Math.round(z * 1000)}`;
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length;
      verts.push([p.x, p.y, z]);
      index.set(k, i);
    }
    return i;
  };
  const loop = (ring: Point[], z: number) => ring.map((p) => vid(p, z));
  const reversed = (ring: Point[]) => [...ring].reverse();

  /** Side faces of a ring in material orientation (outer CCW, hole CW): face normals point away from the material. */
  const sides = (faces: Face[], ring: Point[], z0: number, z1: number) => {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      faces.push({ loops: [[vid(p, z0), vid(q, z0), vid(q, z1), vid(p, z1)]] });
    }
  };

  const shapes = wallFootprint(maze, o.wall);
  const plate = o.base > 0 ? quantize(baseOutline(maze, o.wall, Math.max(o.margin, 0))) : [];

  // Long faces and faces with holes are split along vertical cut lines into
  // smaller, hole-free pieces: CAD kernels import a face bounded by thousands
  // of edges very slowly (OpenCASCADE: 24 s for one 2,250-edge face). The cut
  // points are added to every ring first, so the pieces share their vertices
  // with the side walls and the solid stays watertight.
  const rings: Point[][] = [plate];
  const cutAt: number[] = [];
  const visit = (sh: Shape) => {
    rings.push(sh.outer);
    cutAt.push(midX(sh.outer));
    for (const h of sh.holes) {
      rings.push(h.ring);
      cutAt.push(midX(h.ring));
      h.islands.forEach(visit);
    }
  };
  shapes.forEach(visit);
  // Evenly spaced cuts so no piece has more than a few hundred edges.
  let lo = Infinity,
    hi = -Infinity,
    longest = 0;
  for (const r of rings) {
    longest = Math.max(longest, r.length);
    for (const p of r) {
      lo = Math.min(lo, p.x);
      hi = Math.max(hi, p.x);
    }
  }
  const strips = Math.min(64, Math.ceil(longest / MAX_FACE_EDGES));
  for (let k = 1; k < strips; k++) cutAt.push(Math.round((lo + ((hi - lo) * k) / strips) * UM));
  const cuts = chooseCuts(cutAt, rings);
  const insert = (sh: Shape) => {
    sh.outer = withCuts(sh.outer, cuts);
    for (const h of sh.holes) {
      h.ring = withCuts(h.ring, cuts);
      h.islands.forEach(insert);
    }
  };
  shapes.forEach(insert);
  const plateRing = withCuts(plate, cuts);

  /** A horizontal face from material-oriented rings (outer CCW, holes CW), facing up or down. */
  const cap = (faces: Face[], rs: Point[][], z: number, up: boolean) => {
    const edges = rs.reduce((n, r) => n + r.length, 0);
    const pieces = (rs.length > 1 || edges > MAX_FACE_EDGES) && cuts.length ? splitByCuts(rs, cuts) : [rs];
    for (const piece of pieces) {
      faces.push({ loops: piece.map((r) => loop(up ? r : reversed(r), z)) });
    }
  };

  /** Walls of one shape between z0 and z1: sides and top. Bottom handled by the caller. */
  const wallsOf = (faces: Face[], s: Shape, z0: number, z1: number) => {
    sides(faces, s.outer, z0, z1);
    for (const h of s.holes) sides(faces, h.ring, z0, z1);
    cap(faces, [s.outer, ...s.holes.map((h) => h.ring)], z1, true);
  };

  const bodies: Face[][] = [];
  const top = o.base + o.height;

  if (o.base > 0 && o.margin >= MIN_MARGIN) {
    // One body: plate with the walls standing on it.
    const faces: Face[] = [];
    cap(faces, [plateRing], 0, false);
    sides(faces, plateRing, 0, o.base);
    cap(faces, [plateRing, ...shapes.map((s) => reversed(s.outer))], o.base, true);
    const stand = (s: Shape) => {
      wallsOf(faces, s, o.base, top);
      // Floor showing through any hole in the walls, around any islands in it.
      for (const h of s.holes) {
        cap(faces, [reversed(h.ring), ...h.islands.map((i) => reversed(i.outer))], o.base, true);
        h.islands.forEach(stand);
      }
    };
    shapes.forEach(stand);
    bodies.push(faces);
  } else {
    // Walls as separate bodies (one per connected piece), on a separate plate if asked for.
    if (o.base > 0) {
      const faces: Face[] = [];
      cap(faces, [plateRing], 0, false);
      sides(faces, plateRing, 0, o.base);
      cap(faces, [plateRing], o.base, true);
      bodies.push(faces);
    }
    const free = (s: Shape) => {
      const faces: Face[] = [];
      cap(faces, [s.outer, ...s.holes.map((h) => h.ring)], o.base, false);
      wallsOf(faces, s, o.base, top);
      bodies.push(faces);
      for (const h of s.holes) h.islands.forEach(free);
    };
    shapes.forEach(free);
  }
  return { verts, bodies };
}

// Face splitting -------------------------------------------------------------
// All coordinates handled here are whole micrometres, matching the footprint.

const UM = 1000;

/** Faces with more edges than this are split into strips. */
const MAX_FACE_EDGES = 250;

function quantize(ring: Point[]): Point[] {
  return ring.map((p) => ({ x: Math.round(p.x * UM) / UM, y: Math.round(p.y * UM) / UM }));
}

/** A cut through the middle of a ring's extent, in micrometres. */
function midX(ring: Point[]): number {
  let lo = Infinity,
    hi = -Infinity;
  for (const p of ring) {
    lo = Math.min(lo, p.x);
    hi = Math.max(hi, p.x);
  }
  return Math.round(((lo + hi) / 2) * UM);
}

/** Distinct cut positions that miss every existing vertex. */
function chooseCuts(at: number[], rings: Point[][]): number[] {
  const xs = new Set<number>();
  for (const r of rings) for (const p of r) xs.add(Math.round(p.x * UM));
  const out = new Set<number>();
  for (let c of at) {
    while (xs.has(c)) c++;
    out.add(c);
  }
  return [...out].sort((a, b) => a - b);
}

/** Add a vertex wherever an edge crosses a cut line. */
function withCuts(ring: Point[], cuts: number[]): Point[] {
  if (!ring.length || !cuts.length) return ring;
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    out.push(p);
    const px = p.x * UM;
    const qx = q.x * UM;
    const crossing = cuts.filter((c) => (px < c && c < qx) || (qx < c && c < px));
    if (px > qx) crossing.reverse();
    for (const c of crossing) {
      const t = (c - px) / (qx - px);
      out.push({ x: c / UM, y: Math.round((p.y + t * (q.y - p.y)) * UM) / UM });
    }
  }
  return out;
}

/** Split a face (outer ring plus holes) into strips between the cut lines. */
function splitByCuts(rings: Point[][], cuts: number[]): Point[][][] {
  const toPath = (r: Point[]): Path => r.map((p) => ({ X: Math.round(p.x * UM), Y: Math.round(p.y * UM) }));
  let minY = Infinity,
    maxY = -Infinity,
    minX = Infinity,
    maxX = -Infinity;
  for (const p of rings[0]) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
  }
  const y0 = Math.round(minY * UM) - 1000;
  const y1 = Math.round(maxY * UM) + 1000;
  const edges = [
    Math.round(minX * UM) - 1000,
    ...cuts.filter((c) => c > minX * UM && c < maxX * UM),
    Math.round(maxX * UM) + 1000,
  ];
  // Clipper recomputes points where a ring meets a cut line and can land a
  // micrometre off the crossing already inserted there; snap back to it so
  // neighbouring pieces and side walls share exactly the same vertex.
  const onCut = new Map<number, number[]>();
  const cutSet = new Set(cuts);
  for (const r of rings)
    for (const p of r) {
      const X = Math.round(p.x * UM);
      if (cutSet.has(X)) (onCut.get(X) ?? onCut.set(X, []).get(X)!).push(Math.round(p.y * UM));
    }
  const snap = (X: number, Y: number) => {
    let best = Y;
    let dist = 4;
    for (const y of onCut.get(X) ?? []) {
      const d = Math.abs(y - Y);
      if (d < dist) {
        best = y;
        dist = d;
      }
    }
    return best;
  };
  const pieces: Point[][][] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const strip: Path = [
      { X: edges[k], Y: y0 },
      { X: edges[k + 1], Y: y0 },
      { X: edges[k + 1], Y: y1 },
      { X: edges[k], Y: y1 },
    ];
    const clipper = new ClipperLib.Clipper();
    clipper.PreserveCollinear = true;
    clipper.AddPaths(rings.map(toPath), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths([strip], ClipperLib.PolyType.ptClip, true);
    const tree = new ClipperLib.PolyTree();
    clipper.Execute(
      ClipperLib.ClipType.ctIntersection,
      tree,
      ClipperLib.PolyFillType.pftEvenOdd,
      ClipperLib.PolyFillType.pftNonZero,
    );
    const ring = (path: Path, ccw: boolean): Point[] => {
      const r: Point[] = [];
      for (const p of path) {
        const y = snap(p.X, p.Y);
        const last = r[r.length - 1];
        if (!last || last.x !== p.X / UM || last.y !== y / UM) r.push({ x: p.X / UM, y: y / UM });
      }
      if (r.length > 1 && r[0].x === r[r.length - 1].x && r[0].y === r[r.length - 1].y) r.pop();
      return signedArea(r) > 0 === ccw ? r : r.reverse();
    };
    const walk = (nodes: PolyNode[]) => {
      for (const n of nodes) {
        pieces.push([ring(n.Contour(), true), ...n.Childs().map((h) => ring(h.Contour(), false))]);
        for (const h of n.Childs()) walk(h.Childs());
      }
    };
    walk(tree.Childs());
  }
  return pieces;
}

/** Newell normal of a loop (unnormalised). */
export function loopNormal(verts: V3[], l: number[]): V3 {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < l.length; i++) {
    const a = verts[l[i]];
    const b = verts[l[(i + 1) % l.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}
