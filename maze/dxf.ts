// DXF (R12, the most widely readable flavour) export in millimetres, y up.
// Layers:
//   WALLS        closed outlines of the walls at their real width; extrude
//                these in CAD to get the same solid as the STEP/STL export
//   CENTERLINES  wall centre lines, with true arcs on round mazes
//   SOLUTION     the route from entrance to exit

import type { Maze } from "./generate";
import type { Point } from "./grid";
import { wallEndpoints } from "./grid";
import { toModel, wallFootprint } from "./footprint";
import type { Shape } from "./footprint";

export function encodeDxf(maze: Maze, wall: number): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => {
    out.push(String(code), typeof value === "number" ? num(value) : value);
  };
  const flip = toModel(maze);
  const { minX, minY, maxX, maxY } = maze.grid.bounds;
  const pad = wall / 2;

  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$ACADVER");
  g(1, "AC1009");
  g(9, "$EXTMIN");
  g(10, minX - pad);
  g(20, minY - pad);
  g(9, "$EXTMAX");
  g(10, maxX + pad);
  g(20, maxY + pad);
  g(0, "ENDSEC");

  g(0, "SECTION");
  g(2, "ENTITIES");

  const polyline = (layer: string, pts: Point[], closed: boolean) => {
    g(0, "POLYLINE");
    g(8, layer);
    g(66, 1);
    g(10, 0);
    g(20, 0);
    g(30, 0);
    g(70, closed ? 1 : 0);
    for (const p of pts) {
      g(0, "VERTEX");
      g(8, layer);
      g(10, p.x);
      g(20, p.y);
      g(30, 0);
    }
    g(0, "SEQEND");
    g(8, layer);
  };

  const shape = (s: Shape) => {
    polyline("WALLS", s.outer, true);
    for (const h of s.holes) {
      polyline("WALLS", h.ring, true);
      h.islands.forEach(shape);
    }
  };
  wallFootprint(maze, wall).forEach(shape);

  maze.grid.walls.forEach((w, i) => {
    if (maze.open[i]) return;
    const geom = w.geom;
    if (geom.kind === "line") {
      const [p, q] = wallEndpoints(geom).map(flip);
      g(0, "LINE");
      g(8, "CENTERLINES");
      g(10, p.x);
      g(20, p.y);
      g(30, 0);
      g(11, q.x);
      g(21, q.y);
      g(31, 0);
      return;
    }
    // Mirroring y turns the arc a0..a1 into -a1..-a0, still counter-clockwise.
    const c = flip({ x: geom.cx, y: geom.cy });
    g(0, "ARC");
    g(8, "CENTERLINES");
    g(10, c.x);
    g(20, c.y);
    g(30, 0);
    g(40, geom.r);
    g(50, deg(-geom.a1));
    g(51, deg(-geom.a0));
  });

  polyline("SOLUTION", maze.path.map(flip), false);

  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\r\n") + "\r\n";
}

function deg(rad: number): number {
  const d = (rad * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

function num(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toString();
}
