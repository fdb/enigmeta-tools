// Minimal typings for the parts of clipper-lib (Clipper 6, Angus Johnson) used here.
declare module "clipper-lib" {
  export interface IntPoint {
    X: number;
    Y: number;
  }
  export type Path = IntPoint[];
  export class PolyNode {
    Contour(): Path;
    Childs(): PolyNode[];
    IsHole(): boolean;
  }
  export class PolyTree extends PolyNode {}
  export class Clipper {
    StrictlySimple: boolean;
    PreserveCollinear: boolean;
    AddPaths(paths: Path[], polyType: number, closed: boolean): boolean;
    Execute(clipType: number, solution: PolyTree, subjFill: number, clipFill: number): boolean;
    static CleanPolygon(path: Path, distance?: number): Path;
  }
  const ClipperLib: {
    Clipper: typeof Clipper;
    PolyTree: typeof PolyTree;
    ClipType: { ctUnion: number; ctIntersection: number };
    PolyType: { ptSubject: number; ptClip: number };
    PolyFillType: { pftNonZero: number; pftEvenOdd: number };
  };
  export default ClipperLib;
}
