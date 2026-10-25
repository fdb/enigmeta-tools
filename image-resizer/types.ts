export type Method = "smooth" | "pixel" | "carve";

export interface Img {
  w: number;
  h: number;
  data: Uint8Array; // RGBA
}

export interface Job {
  id: number;
  method: Method;
  w: number;
  h: number;
  filter: string;
  linear: boolean;
  /** Content-aware: share of the size change done by seams, 0..1. */
  amount: number;
  forward: boolean;
  order: "wh" | "hw";
  /** 1 = protect, 2 = remove; any resolution. */
  mask: Img | null;
  /** Downscale the source for content-aware previews above this many MP. */
  preview: boolean;
  previewMp: number;
  wantSeams: boolean;
}

export type WorkerOut =
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "error"; id: number; message: string }
  | {
      type: "done";
      id: number;
      result: Img;
      ms: number;
      seams: number;
      /** True when this is a reduced-size content-aware preview. */
      preview: boolean;
      carved?: { base: Img; removed: Uint8Array; inserted: Uint8Array };
    };
