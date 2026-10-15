// SVG rendering of a maze, sized in millimetres so it prints or cuts to scale.

import type { Maze } from "./generate";
import type { WallGeom } from "./grid";
import { fmt, wallEndpoints } from "./grid";

export interface SvgOptions {
  /** Wall stroke width in mm. */
  wall: number;
  /** Empty border around the maze in mm. */
  margin: number;
  solution: boolean;
  /** Fill cells with a colour ramp by distance from the entrance. */
  heatmap: boolean;
  /** Wall colour; "currentColor" for the on-page preview. */
  ink: string;
  /** Solution colour. */
  route: string;
  /** Background fill, or "" for transparent. */
  paper: string;
}

/** SVG path commands for one wall. */
export function wallPath(g: WallGeom): string {
  const [p, q] = wallEndpoints(g);
  if (g.kind === "line") return `M${fmt(p.x)} ${fmt(p.y)}L${fmt(q.x)} ${fmt(q.y)}`;
  const span = g.a1 - g.a0;
  const r = fmt(g.r);
  if (span > Math.PI) {
    // Split so neither half is ambiguous for the SVG arc flags.
    const am = (g.a0 + g.a1) / 2;
    const mx = fmt(g.cx + g.r * Math.cos(am));
    const my = fmt(g.cy + g.r * Math.sin(am));
    return `M${fmt(p.x)} ${fmt(p.y)}A${r} ${r} 0 0 1 ${mx} ${my}A${r} ${r} 0 0 1 ${fmt(q.x)} ${fmt(q.y)}`;
  }
  return `M${fmt(p.x)} ${fmt(p.y)}A${r} ${r} 0 0 1 ${fmt(q.x)} ${fmt(q.y)}`;
}

export function renderSvg(maze: Maze, o: SvgOptions): string {
  const g = maze.grid;
  const { minX, minY, maxX, maxY } = g.bounds;
  const pad = o.margin + o.wall / 2;
  const x0 = minX - pad;
  const y0 = minY - pad;
  const w = maxX - minX + 2 * pad;
  const h = maxY - minY + 2 * pad;
  const cap = g.kind === "square" ? "square" : "round";

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
      `viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)}">`,
  );
  if (o.paper)
    parts.push(`<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(w)}" height="${fmt(h)}" fill="${o.paper}"/>`);

  if (o.heatmap) {
    const max = maze.distance.reduce((a, b) => Math.max(a, b), 1);
    // A hairline stroke in the fill colour hides anti-aliasing seams between cells.
    parts.push(`<g stroke-width="${fmt(o.wall / 4)}">`);
    g.shapes.forEach((d, i) => {
      const c = heat(maze.distance[i] / max);
      parts.push(`<path d="${d}" fill="${c}" stroke="${c}"/>`);
    });
    parts.push(`</g>`);
  }

  if (o.solution) {
    const sw = Math.max(o.wall, cellSize(maze) * 0.22);
    // The path alternates wall midpoints and cell centres; curve through the
    // midpoints using each centre as the control point, so turns are rounded.
    const P = maze.path.map((p) => `${fmt(p.x)} ${fmt(p.y)}`);
    let route = `M${P[0]}`;
    let i = 1;
    if (maze.doors[0] < 0) {
      route += `L${P[1]}`;
      i = 2;
    }
    for (; i + 1 < P.length; i += 2) route += `Q${P[i]} ${P[i + 1]}`;
    parts.push(
      `<path d="${route}" fill="none" stroke="${o.route}" stroke-width="${fmt(sw)}" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  const d = g.walls
    .map((wall, i) => (maze.open[i] ? "" : wallPath(wall.geom)))
    .filter(Boolean)
    .join("");
  parts.push(
    `<path d="${d}" fill="none" stroke="${o.ink}" stroke-width="${fmt(o.wall)}" ` +
      `stroke-linecap="${cap}" stroke-linejoin="${cap === "square" ? "miter" : "round"}"/>`,
  );
  parts.push(`</svg>`);
  return parts.join("\n");
}

/** Typical cell size: the median wall length. */
export function cellSize(maze: Maze): number {
  const lens = maze.grid.walls
    .map((w) => {
      const [p, q] = wallEndpoints(w.geom);
      return Math.hypot(q.x - p.x, q.y - p.y);
    })
    .sort((a, b) => a - b);
  return lens[Math.floor(lens.length / 2)] || 1;
}

/** Distance ramp: a hue sweep at constant OKLCH lightness, emitted as hex for compatibility with cutters and editors. */
function heat(t: number): string {
  return oklchToHex(0.86, 0.09, 250 - 250 * t);
}

function oklchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return (
    "#" +
    lin
      .map((v) => {
        const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.round(Math.min(1, Math.max(0, c)) * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
