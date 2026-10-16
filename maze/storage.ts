// Ball storage at the entrance and/or exit, for a physical maze that keeps its
// ball inside.
//
//   none    the doorway stays an opening in the outer wall
//   closed  the doorway is walled off; the ball rests in the end cell
//   pocket  the corridor carries on past the outer wall into a closed bay
//   hook    an L-shaped bay: out through the doorway, then sideways into a
//           foot with a small notch the ball rests behind, so it cannot roll
//           straight back into the maze

import type { Maze } from "./generate";
import type { Line, Point } from "./grid";
import { wallEndpoints } from "./grid";

export type Storage = "none" | "closed" | "pocket" | "hook";
export type Placement = "start" | "end" | "both";

export interface StorageOptions {
  storage: Storage;
  /** Which doorway gets the storage. */
  placement: Placement;
  /** Ball diameter in mm. */
  ball: number;
  /** Wall width in mm. */
  wall: number;
}

/** Free space left around the ball inside the alcove, per side, in mm. */
export const BALL_CLEARANCE = 0.5;
/** Height of the notch in the L-shaped bay, as a fraction of the ball diameter. */
export const NOTCH = 1 / 3;

export function applyStorage(maze: Maze, o: StorageOptions): Maze {
  if (o.storage === "none") return maze;
  const atStart = o.placement !== "end" && maze.doors[0] >= 0;
  const atEnd = o.placement !== "start";
  let { open, path } = maze;
  const extra: Line[] = [...maze.extra];

  if (o.storage === "closed") {
    open = [...open];
    if (atStart) {
      open[maze.doors[0]] = false;
      path = path.slice(1);
    }
    if (atEnd) {
      open[maze.doors[1]] = false;
      path = path.slice(0, -1);
    }
    return { ...maze, open, path };
  }

  if (atStart) {
    const a = alcove(maze, 0, o);
    extra.push(...a.walls);
    path = [...a.route, ...path];
  }
  if (atEnd) {
    const a = alcove(maze, 1, o);
    extra.push(...a.walls);
    path = [...path, ...a.route.reverse()];
  }
  return { ...maze, extra, path };
}

/**
 * Walls of a pocket or hook outside doorway `which` (0 = entrance, 1 = exit),
 * and the route from where the ball rests back to the doorway.
 */
function alcove(maze: Maze, which: 0 | 1, o: StorageOptions): { walls: Line[]; route: Point[] } {
  // Local frame at the doorway: x along the doorway, y outward.
  const g = maze.grid;
  const [p, q] = wallEndpoints(g.walls[maze.doors[which]].geom);
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  const t = { x: (q.x - p.x) / L, y: (q.y - p.y) / L };
  const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const c = g.centers[which === 0 ? maze.start : maze.end];
  let n = { x: -t.y, y: t.x };
  if (n.x * (m.x - c.x) + n.y * (m.y - c.y) < 0) n = { x: -n.x, y: -n.y };
  const at = (x: number, y: number): Point => ({ x: m.x + x * t.x + y * n.x, y: m.y + x * t.y + y * n.y });

  const w = o.wall;
  const room = o.ball + 2 * BALL_CLEARANCE; // clear space the ball needs
  const half = L / 2;
  let pts: [number, number][][];
  let route: Point[];

  if (o.storage === "pocket") {
    // The corridor carries on past the outer wall into a closed bay deep enough for the ball.
    const depth = room + w;
    pts = [
      [
        [-half, 0],
        [-half, depth],
        [half, depth],
        [half, 0],
      ],
    ];
    route = [at(0, depth / 2)];
  } else {
    // Hook: a channel straight out, then a foot to the side towards the maze's
    // middle, so the bay hugs the maze instead of sticking out past a corner.
    const { minX, minY, maxX, maxY } = g.bounds;
    const side = t.x * ((minX + maxX) / 2 - m.x) + t.y * ((minY + maxY) / 2 - m.y) >= 0 ? 1 : -1;
    // On a straight outer edge the foot can sit right on the outer wall; on
    // curved or zigzag edges it is lifted one wall width clear of it.
    const neck = g.kind === "square" ? 0 : w;
    // The notch rises from the inner corner of the foot. The channel is made
    // tall enough that the ball still passes over the notch into the foot.
    const notch = o.ball * NOTCH;
    const foot = room + w;
    const top = Math.max(neck + L, neck + notch + room + w);
    pts = [
      [
        [-half, 0],
        [-half, top],
        [half + foot, top],
        [half + foot, neck],
        [half, neck],
        [half, 0],
      ],
      [
        [half, neck],
        [half, neck + notch],
      ],
    ].map((run) => run.map(([x, y]) => [x * side, y] as [number, number]));
    const restX = side * (half + foot / 2);
    const over = (neck + notch + top) / 2; // middle of the gap above the notch
    route = [at(restX, neck + (w + room) / 2), at(restX, over), at(0, over)];
  }

  const walls: Line[] = [];
  for (const run of pts) {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = at(...run[i]);
      const b = at(...run[i + 1]);
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
      walls.push({ kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  return { walls, route };
}

/** Clear corridor width of the maze, and whether the ball fits through it. */
export function ballFits(cell: number, wall: number, ball: number): boolean {
  return cell - wall >= ball + BALL_CLEARANCE;
}
