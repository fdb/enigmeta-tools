// Binary STL, triangulated from the shared solid model: watertight, one shell
// per body, in millimetres.

import earcut from "earcut";
import type { Model, V3 } from "./solid";
import { loopNormal } from "./solid";

export function triangulate(model: Model): V3[][] {
  const { verts } = model;
  const tris: V3[][] = [];
  for (const body of model.bodies) {
    for (const face of body) {
      const n = loopNormal(verts, face.loops[0]);
      // Project onto the plane's dominant axis pair.
      const ax = Math.abs(n[0]);
      const ay = Math.abs(n[1]);
      const az = Math.abs(n[2]);
      const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
      const ids = face.loops.flat();
      const flat: number[] = [];
      const holes: number[] = [];
      for (const l of face.loops) {
        if (flat.length) holes.push(flat.length / 2);
        for (const i of l) flat.push(verts[i][u], verts[i][v]);
      }
      const idx = earcut(flat, holes);
      for (let t = 0; t < idx.length; t += 3) {
        let a = verts[ids[idx[t]]];
        let b = verts[ids[idx[t + 1]]];
        const c = verts[ids[idx[t + 2]]];
        // earcut's winding is arbitrary; match the face normal.
        const tn = cross(sub(b, a), sub(c, a));
        if (tn[0] * n[0] + tn[1] * n[1] + tn[2] * n[2] < 0) [a, b] = [b, a];
        tris.push([a, b, c]);
      }
    }
  }
  return tris;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function encodeStl(model: Model): ArrayBuffer {
  const tris = triangulate(model);
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const dv = new DataView(buf);
  const header = "enigmeta maze, units: mm";
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    const n = cross(sub(b, a), sub(c, a));
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const f of [n[0] / len, n[1] / len, n[2] / len, ...a, ...b, ...c]) {
      dv.setFloat32(o, f, true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
