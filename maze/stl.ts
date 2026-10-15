// Binary STL export: walls extruded to solids, with joint posts at every wall
// end so corners close at any angle, and an optional ground plate. Walls are
// separate overlapping solids; slicers merge overlapping shells on import.

import type { Maze } from "./generate";
import type { Point } from "./grid";
import { wallEndpoints } from "./grid";

export interface StlOptions {
  /** Wall thickness in mm. */
  wall: number;
  /** Wall height above the ground plate (or above z = 0 without one) in mm. */
  height: number;
  /** Ground plate thickness in mm; 0 for none. */
  base: number;
  /** How far the ground plate extends past the outer walls, in mm. */
  margin: number;
}

type V3 = [number, number, number];

class Mesh {
  tris: V3[][] = [];

  tri(a: V3, b: V3, c: V3) {
    this.tris.push([a, b, c]);
  }

  quad(a: V3, b: V3, c: V3, d: V3) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Closed solid from an outline extruded between z0 and z1. Caps are fanned, so the outline must be convex. */
  prism(outline: Point[], z0: number, z1: number) {
    const pts = ccw(outline);
    const n = pts.length;
    for (let i = 1; i < n - 1; i++) {
      this.tri(v(pts[0], z1), v(pts[i], z1), v(pts[i + 1], z1));
      this.tri(v(pts[0], z0), v(pts[i + 1], z0), v(pts[i], z0));
    }
    this.sides(pts, z0, z1);
  }

  /** Outward-facing side walls of a counter-clockwise outline. */
  sides(pts: Point[], z0: number, z1: number) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      this.quad(v(p, z0), v(q, z0), v(q, z1), v(p, z1));
    }
  }
}

const v = (p: Point, z: number): V3 => [p.x, p.y, z];

function area(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

const ccw = (pts: Point[]) => (area(pts) < 0 ? [...pts].reverse() : pts);

function ngon(c: Point, r: number, n: number): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

export function buildStl(maze: Maze, o: StlOptions): ArrayBuffer {
  const g = maze.grid;
  const mesh = new Mesh();
  const hw = o.wall / 2;
  // Sink walls halfway into the plate so they overlap it instead of sharing a face.
  const z0 = o.base > 0 ? o.base / 2 : 0;
  const z1 = o.base + o.height;
  const posts = new Map<string, Point>();
  const addPost = (p: Point) => posts.set(`${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`, p);

  g.walls.forEach((wall, i) => {
    if (maze.open[i]) return;
    const geom = wall.geom;
    const [p, q] = wallEndpoints(geom);
    addPost(p);
    addPost(q);
    if (geom.kind === "line") {
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const nx = (-(q.y - p.y) / len) * hw;
      const ny = ((q.x - p.x) / len) * hw;
      mesh.prism(
        [
          { x: p.x - nx, y: p.y - ny },
          { x: q.x - nx, y: q.y - ny },
          { x: q.x + nx, y: q.y + ny },
          { x: p.x + nx, y: p.y + ny },
        ],
        z0,
        z1,
      );
      return;
    }
    // Arc: a curved slab, segmented to about 1 mm along the centreline.
    const steps = Math.max(2, Math.ceil(((geom.a1 - geom.a0) * geom.r) / 1));
    const outer: Point[] = [];
    const inner: Point[] = [];
    for (let k = 0; k <= steps; k++) {
      const a = geom.a0 + ((geom.a1 - geom.a0) * k) / steps;
      const c = Math.cos(a);
      const s = Math.sin(a);
      outer.push({ x: geom.cx + (geom.r + hw) * c, y: geom.cy + (geom.r + hw) * s });
      inner.push({ x: geom.cx + Math.max(0, geom.r - hw) * c, y: geom.cy + Math.max(0, geom.r - hw) * s });
    }
    const outline = ccw([...outer, ...[...inner].reverse()]);
    mesh.sides(outline, z0, z1);
    // Caps as quads along the strip, wound to face up (top) and down (bottom).
    for (let k = 0; k < steps; k++) {
      const quad = ccw([outer[k], outer[k + 1], inner[k + 1], inner[k]]);
      mesh.quad(v(quad[0], z1), v(quad[1], z1), v(quad[2], z1), v(quad[3], z1));
      mesh.quad(v(quad[0], z0), v(quad[3], z0), v(quad[2], z0), v(quad[1], z0));
    }
  });

  for (const p of posts.values()) {
    if (g.kind === "square") {
      mesh.prism(
        [
          { x: p.x - hw, y: p.y - hw },
          { x: p.x + hw, y: p.y - hw },
          { x: p.x + hw, y: p.y + hw },
          { x: p.x - hw, y: p.y + hw },
        ],
        z0,
        z1,
      );
    } else {
      mesh.prism(ngon(p, hw, 16), z0, z1);
    }
  }

  if (o.base > 0) {
    const { minX, minY, maxX, maxY } = g.bounds;
    const m = o.margin + hw;
    if (g.kind === "round") {
      const r = (maxX - minX) / 2 + m;
      mesh.prism(
        ngon({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, r, Math.max(64, Math.ceil(2 * Math.PI * r))),
        0,
        o.base,
      );
    } else {
      mesh.prism(
        [
          { x: minX - m, y: minY - m },
          { x: maxX + m, y: minY - m },
          { x: maxX + m, y: maxY + m },
          { x: minX - m, y: maxY + m },
        ],
        0,
        o.base,
      );
    }
  }

  return encode(mesh, g.bounds.minY + g.bounds.maxY);
}

/**
 * Binary STL. The maze is laid out in SVG coordinates (y down), so y is
 * mirrored to keep the model reading the same way from above; mirroring flips
 * winding, so each triangle's last two vertices are swapped to compensate.
 */
function encode(mesh: Mesh, flip: number): ArrayBuffer {
  const n = mesh.tris.length;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  const header = "enigmeta maze";
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  for (const [a, b, c] of mesh.tris) {
    const pa: V3 = [a[0], flip - a[1], a[2]];
    const pb: V3 = [c[0], flip - c[1], c[2]];
    const pc: V3 = [b[0], flip - b[1], b[2]];
    const ux = pb[0] - pa[0],
      uy = pb[1] - pa[1],
      uz = pb[2] - pa[2];
    const wx = pc[0] - pa[0],
      wy = pc[1] - pa[1],
      wz = pc[2] - pa[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const f of [nx, ny, nz, ...pa, ...pb, ...pc]) {
      dv.setFloat32(o, f, true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
