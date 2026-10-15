// The 3D maze as a polyhedral boundary representation: shared vertices,
// planar faces (outer loop plus hole loops), grouped into closed bodies. The
// STL and STEP exports are both written from this, so they are watertight
// and describe the same solid.

import type { Maze } from "./generate";
import type { Point } from "./grid";
import type { Shape } from "./footprint";
import { baseOutline, wallFootprint } from "./footprint";

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

  /** Walls of one shape between z0 and z1: sides and top. Bottom handled by the caller. */
  const wallsOf = (faces: Face[], s: Shape, z0: number, z1: number) => {
    sides(faces, s.outer, z0, z1);
    for (const h of s.holes) sides(faces, h.ring, z0, z1);
    faces.push({ loops: [loop(s.outer, z1), ...s.holes.map((h) => loop(h.ring, z1))] });
  };

  const shapes = wallFootprint(maze, o.wall);
  const bodies: Face[][] = [];
  const top = o.base + o.height;

  if (o.base > 0 && o.margin >= MIN_MARGIN) {
    // One body: plate with the walls standing on it.
    const faces: Face[] = [];
    const plate = baseOutline(maze, o.wall, o.margin);
    faces.push({ loops: [loop(reversed(plate), 0)] });
    sides(faces, plate, 0, o.base);
    faces.push({ loops: [loop(plate, o.base), ...shapes.map((s) => loop(reversed(s.outer), o.base))] });
    const stand = (s: Shape) => {
      wallsOf(faces, s, o.base, top);
      // Floor showing through any hole in the walls, around any islands in it.
      for (const h of s.holes) {
        faces.push({
          loops: [loop(reversed(h.ring), o.base), ...h.islands.map((i) => loop(reversed(i.outer), o.base))],
        });
        h.islands.forEach(stand);
      }
    };
    shapes.forEach(stand);
    bodies.push(faces);
  } else {
    // Walls as separate bodies (one per connected piece), on a separate plate if asked for.
    if (o.base > 0) {
      const plate = baseOutline(maze, o.wall, Math.max(o.margin, 0));
      const faces: Face[] = [{ loops: [loop(reversed(plate), 0)] }];
      sides(faces, plate, 0, o.base);
      faces.push({ loops: [loop(plate, o.base)] });
      bodies.push(faces);
    }
    const free = (s: Shape) => {
      const faces: Face[] = [
        { loops: [loop(reversed(s.outer), o.base), ...s.holes.map((h) => loop(reversed(h.ring), o.base))] },
      ];
      wallsOf(faces, s, o.base, top);
      bodies.push(faces);
      for (const h of s.holes) h.islands.forEach(free);
    };
    shapes.forEach(free);
  }
  return { verts, bodies };
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
