// STEP (ISO 10303-21, AP214) export of the solid model as B-rep solids with
// planar faces, in millimetres. CAD tools such as Inventor import this as
// real solid bodies rather than a mesh.

import type { Model, V3 } from "./solid";
import { loopNormal } from "./solid";

/** STEP reals must contain a decimal point. */
function real(n: number): string {
  const s = (Math.abs(n) < 1e-12 ? 0 : Math.round(n * 1e6) / 1e6).toString();
  return /[.eE]/.test(s) ? s : `${s}.`;
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const triple = (v: V3) => `(${real(v[0])},${real(v[1])},${real(v[2])})`;

export function encodeStep(model: Model, name: string, timestamp = new Date().toISOString().slice(0, 19)): string {
  const lines: string[] = [];
  let next = 1;
  const add = (entity: string) => {
    const id = next++;
    lines.push(`#${id}=${entity};`);
    return `#${id}`;
  };
  const esc = (s: string) => s.replace(/'/g, "''");

  const appCtx = add(`APPLICATION_CONTEXT('automotive design')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = add(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const product = add(`PRODUCT('${esc(name)}','${esc(name)}','',(${prodCtx}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(${product}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const defCtx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const def = add(`PRODUCT_DEFINITION('design','',${formation},${defCtx})`);
  const defShape = add(`PRODUCT_DEFINITION_SHAPE('','',${def})`);
  const mm = add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const rad = add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sr = add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const uncertainty = add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-04),${mm},'distance_accuracy_value','confusion accuracy')`,
  );
  const geomCtx = add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty}))` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr}))REPRESENTATION_CONTEXT('Context3D','3D context'))`,
  );

  const origin = add(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const zDir = add(`DIRECTION('',(0.,0.,1.))`);
  const xDir = add(`DIRECTION('',(1.,0.,0.))`);
  const placement = add(`AXIS2_PLACEMENT_3D('',${origin},${zDir},${xDir})`);

  const { verts } = model;
  const vertexRef = new Map<number, string>();
  const vertex = (i: number) => {
    let r = vertexRef.get(i);
    if (!r) {
      const pt = add(`CARTESIAN_POINT('',${triple(verts[i])})`);
      r = add(`VERTEX_POINT('',${pt})`);
      vertexRef.set(i, r);
    }
    return r;
  };
  // Each edge is written once, running from its lower to its higher vertex index.
  const edgeRef = new Map<string, string>();
  const edge = (a: number, b: number) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo},${hi}`;
    let r = edgeRef.get(key);
    if (!r) {
      const p = verts[lo];
      const q = verts[hi];
      const d: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const pt = add(`CARTESIAN_POINT('',${triple(p)})`);
      const dir = add(`DIRECTION('',${triple(norm(d))})`);
      const vec = add(`VECTOR('',${dir},${real(len)})`);
      const line = add(`LINE('',${pt},${vec})`);
      r = add(`EDGE_CURVE('',${vertex(lo)},${vertex(hi)},${line},.T.)`);
      edgeRef.set(key, r);
    }
    return `ORIENTED_EDGE('',*,*,${r},${a < b ? ".T." : ".F."})`;
  };

  const solids: string[] = [];
  model.bodies.forEach((body, bi) => {
    const faces: string[] = [];
    for (const face of body) {
      const outer = face.loops[0];
      const n = norm(loopNormal(verts, outer));
      const p0 = verts[outer[0]];
      // Reference direction: the first non-degenerate edge, which lies in the plane.
      let ref: V3 = [1, 0, 0];
      for (let i = 1; i < outer.length; i++) {
        const q = verts[outer[i]];
        const d: V3 = [q[0] - p0[0], q[1] - p0[1], q[2] - p0[2]];
        const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
        const inPlane: V3 = [d[0] - along * n[0], d[1] - along * n[1], d[2] - along * n[2]];
        if (Math.hypot(...inPlane) > 1e-6) {
          ref = norm(inPlane);
          break;
        }
      }
      const pt = add(`CARTESIAN_POINT('',${triple(p0)})`);
      const axis = add(`DIRECTION('',${triple(n)})`);
      const refDir = add(`DIRECTION('',${triple(ref)})`);
      const plane = add(`PLANE('',${add(`AXIS2_PLACEMENT_3D('',${pt},${axis},${refDir})`)})`);
      const bounds = face.loops.map((l, li) => {
        const oes = l.map((v, k) => add(edge(v, l[(k + 1) % l.length])));
        const el = add(`EDGE_LOOP('',(${oes.join(",")}))`);
        return add(`${li === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',${el},.T.)`);
      });
      faces.push(add(`ADVANCED_FACE('',(${bounds.join(",")}),${plane},.T.)`));
    }
    const shell = add(`CLOSED_SHELL('',(${faces.join(",")}))`);
    solids.push(add(`MANIFOLD_SOLID_BREP('${model.bodies.length > 1 ? `body ${bi + 1}` : esc(name)}',${shell})`));
  });

  const rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${placement},${solids.join(",")}),${geomCtx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${defShape},${rep})`);

  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('maze'),'2;1');",
    `FILE_NAME('${esc(name)}.step','${timestamp}',(''),(''),'tools.enigmeta.com maze','tools.enigmeta.com maze','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}
