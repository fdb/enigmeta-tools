// Ball storage at the entrance, for a physical maze that keeps its ball inside.
//
//   none    the entrance stays an opening in the outer wall
//   closed  the entrance is walled off; the ball rests in the first cell
//   pocket  the corridor carries on past the outer wall into a closed bay
//   hook    an L-shaped bay: out through the entrance, then sideways, so the
//           ball sits behind a wall and cannot roll straight back into the maze

import type { Maze } from "./generate";
import type { Line, Point } from "./grid";
import { wallEndpoints } from "./grid";

export type Storage = "none" | "closed" | "pocket" | "hook";

export interface StorageOptions {
  storage: Storage;
  /** Ball diameter in mm. */
  ball: number;
  /** Wall width in mm. */
  wall: number;
}

/** Free space left around the ball inside the alcove, per side, in mm. */
export const BALL_CLEARANCE = 0.5;

export function applyStorage(maze: Maze, o: StorageOptions): Maze {
  const door = maze.doors[0];
  if (o.storage === "none" || door < 0) return maze;

  if (o.storage === "closed") {
    const open = [...maze.open];
    open[door] = false;
    return { ...maze, open, path: maze.path.slice(1) };
  }

  // Local frame at the entrance: x along the doorway, y outward.
  const g = maze.grid;
  const [p, q] = wallEndpoints(g.walls[door].geom);
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  const t = { x: (q.x - p.x) / L, y: (q.y - p.y) / L };
  const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const c = g.centers[maze.start];
  let n = { x: -t.y, y: t.x };
  if (n.x * (m.x - c.x) + n.y * (m.y - c.y) < 0) n = { x: -n.x, y: -n.y };
  const at = (x: number, y: number): Point => ({ x: m.x + x * t.x + y * n.x, y: m.y + x * t.y + y * n.y });

  const w = o.wall;
  const room = o.ball + 2 * BALL_CLEARANCE; // clear space the ball needs
  const half = L / 2;
  let pts: [number, number][];

  let route: Point[];
  if (o.storage === "pocket") {
    // The corridor carries on past the outer wall into a closed bay deep enough for the ball.
    const depth = room + w;
    pts = [
      [-half, 0],
      [-half, depth],
      [half, depth],
      [half, 0],
    ];
    route = [at(0, depth / 2)];
  } else {
    // Hook: a channel straight out, then a foot to the side towards the maze's
    // middle, so the bay hugs the maze instead of sticking out past a corner.
    // The wall under the foot is the lip the ball rests behind.
    const { minX, minY, maxX, maxY } = g.bounds;
    const side = t.x * ((minX + maxX) / 2 - m.x) + t.y * ((minY + maxY) / 2 - m.y) >= 0 ? 1 : -1;
    // On a straight outer edge the foot can sit right on the outer wall; on
    // curved or zigzag edges it is lifted one wall width clear of it.
    const neck = g.kind === "square" ? 0 : w;
    const foot = room + w;
    const top = neck + L;
    pts = [
      [-half, 0],
      [-half, top],
      [half + foot, top],
      [half + foot, neck],
      [half, neck],
      [half, 0],
    ].map(([x, y]) => [x * side, y] as [number, number]);
    const mid = neck + L / 2;
    route = [at(side * (half + foot / 2), mid), at(0, mid)];
  }

  const extra: Line[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = at(...pts[i]);
    const b = at(...pts[i + 1]);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
    extra.push({ kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  // The route starts where the ball rests instead of at the doorway.
  return { ...maze, extra, path: [...route, ...maze.path] };
}

/** Clear corridor width of the maze, and whether the ball fits through it. */
export function ballFits(cell: number, wall: number, ball: number): boolean {
  return cell - wall >= ball + BALL_CLEARANCE;
}
