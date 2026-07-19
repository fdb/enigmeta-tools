// Core datamoshing pipeline built on WebCodecs.
//
// The mosh is real bitstream surgery, not a pixel filter: the source is
// re-encoded to VP8 (keyframes only on the first frame and at detected scene
// cuts), and the *encoded chunk stream* is then manipulated — keyframes
// removed, P-frames duplicated or dropped — before being fed to a VideoDecoder
// that dutifully applies motion vectors against the wrong reference frames.

export interface MoshChunk {
  type: "key" | "delta";
  data: Uint8Array;
  timestamp: number; // µs
  duration: number; // µs
}

export interface CapturedClip {
  chunks: MoshChunk[];
  width: number;
  height: number;
  fps: number;
}

export interface CaptureOptions {
  /** Target bitrate in bits/s. Lower = chunkier macroblocks = uglier mosh. */
  bitrate: number;
  /** Longest output edge; frames are scaled down to this. */
  maxSize?: number;
  onProgress?: (fraction: number) => void;
}

export interface MoshParams {
  /** Remove keyframes so scene cuts melt into each other. */
  meltCuts: boolean;
  /** Start a bloom (P-frame duplication) every N frames. 0 = off. */
  bloomEvery: number;
  /** How many times the chosen P-frame is re-applied. */
  bloomRepeats: number;
  /** Chance (0..1) that any given P-frame is silently dropped. */
  dropChance: number;
}

export const isSupported = (): boolean =>
  typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";

export async function vp8Supported(): Promise<boolean> {
  if (!isSupported()) return false;
  try {
    const enc = await VideoEncoder.isConfigSupported({
      codec: "vp8",
      width: 640,
      height: 360,
      bitrate: 1_000_000,
    });
    const dec = await VideoDecoder.isConfigSupported({ codec: "vp8" });
    return Boolean(enc.supported && dec.supported);
  } catch {
    return false;
  }
}

/** Mean absolute pixel difference between two RGBA buffers (0..255). */
function frameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  // Sample every 4th pixel's red+green channels — plenty for cut detection.
  for (let i = 0; i < a.length; i += 16) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]);
  }
  return sum / (a.length / 8);
}

const CUT_THRESHOLD = 30; // mean abs diff above this = scene cut
const MIN_KEY_GAP = 5; // frames; don't key twice in rapid succession

/**
 * Play a video file (muted, offscreen) and re-encode it to VP8 in real time.
 * Keyframes are forced on the first frame and at detected scene cuts — exactly
 * the frames classic datamoshing rips out.
 */
export function captureFile(file: File, opts: CaptureOptions): Promise<CapturedClip> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    let done = false;
    const finish = (err?: Error, clip?: CapturedClip) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      if (err) reject(err);
      else resolve(clip!);
    };

    video.onerror = () => finish(new Error("Could not play this video file in your browser."));

    video.onloadedmetadata = async () => {
      const maxSize = opts.maxSize ?? 1280;
      const scale = Math.min(1, maxSize / Math.max(video.videoWidth, video.videoHeight));
      // VP8 wants even dimensions.
      const width = Math.max(2, Math.floor((video.videoWidth * scale) / 2) * 2);
      const height = Math.max(2, Math.floor((video.videoHeight * scale) / 2) * 2);
      if (!width || !height) {
        finish(new Error("This file has no video track."));
        return;
      }

      const frameCanvas = new OffscreenCanvas(width, height);
      const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: false })!;
      const probeCanvas = new OffscreenCanvas(48, 27);
      const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true })!;

      const raw: { type: "key" | "delta"; data: Uint8Array }[] = [];
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          raw.push({ type: chunk.type as "key" | "delta", data });
        },
        error: (e) => finish(new Error(`Encoder error: ${e.message}`)),
      });
      encoder.configure({
        codec: "vp8",
        width,
        height,
        bitrate: opts.bitrate,
        framerate: 30,
        latencyMode: "quality",
      });

      let prevProbe: Uint8ClampedArray | null = null;
      let framesSinceKey = 0;
      let frameCount = 0;

      const onFrame = () => {
        if (done) return;
        frameCtx.drawImage(video, 0, 0, width, height);
        probeCtx.drawImage(video, 0, 0, 48, 27);
        const probe = probeCtx.getImageData(0, 0, 48, 27).data;

        let keyFrame = frameCount === 0;
        if (prevProbe && framesSinceKey >= MIN_KEY_GAP && frameDiff(prevProbe, probe) > CUT_THRESHOLD) {
          keyFrame = true; // scene cut → plant a keyframe (to be ripped out later)
        }
        prevProbe = probe;
        framesSinceKey = keyFrame ? 0 : framesSinceKey + 1;

        const frame = new VideoFrame(frameCanvas, {
          timestamp: Math.round(video.currentTime * 1e6),
        });
        encoder.encode(frame, { keyFrame });
        frame.close();
        frameCount++;

        opts.onProgress?.(video.duration ? video.currentTime / video.duration : 0);
        video.requestVideoFrameCallback(onFrame);
      };

      video.onended = async () => {
        try {
          await encoder.flush();
          encoder.close();
        } catch {
          /* flush after error — the error handler already rejected */
        }
        if (raw.length < 2) {
          finish(new Error("Could not read any frames from this video."));
          return;
        }
        const fps = Math.max(1, Math.round(frameCount / video.duration));
        const dur = Math.round(1e6 / fps);
        const chunks: MoshChunk[] = raw.map((c, i) => ({
          type: c.type,
          data: c.data,
          timestamp: i * dur,
          duration: dur,
        }));
        opts.onProgress?.(1);
        finish(undefined, { chunks, width, height, fps });
      };

      video.requestVideoFrameCallback(onFrame);
      try {
        await video.play();
      } catch (e) {
        finish(new Error(`Could not start playback: ${e instanceof Error ? e.message : e}`));
      }
    };
  });
}

/** Deterministic PRNG so re-moshing with the same params gives the same drops. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The actual datamosh: operate purely on the encoded VP8 chunk stream.
 * - Keyframe removal: every keyframe after the first is deleted, so the
 *   following P-frames apply their motion to whatever scene came before.
 * - Bloom: a P-frame is duplicated N times, re-applying its motion vectors
 *   and residuals over and over — the classic smearing "bloom".
 * - Drop: P-frames vanish, so later motion references stale content.
 */
export function mosh(clip: CapturedClip, params: MoshParams): CapturedClip {
  const rand = mulberry32(0xda7a);
  const out: { type: "key" | "delta"; data: Uint8Array }[] = [];
  let sinceBloom = 0;

  clip.chunks.forEach((chunk, i) => {
    if (i === 0) {
      out.push(chunk); // the decoder needs one keyframe to start from
      return;
    }
    if (chunk.type === "key") {
      if (params.meltCuts) return; // rip it out — this is the mosh
      out.push(chunk);
      return;
    }
    if (params.dropChance > 0 && rand() < params.dropChance) return;

    out.push(chunk);
    sinceBloom++;
    if (params.bloomEvery > 0 && sinceBloom >= params.bloomEvery) {
      sinceBloom = 0;
      for (let r = 0; r < params.bloomRepeats; r++) {
        out.push({ type: "delta", data: chunk.data });
      }
    }
  });

  const dur = Math.round(1e6 / clip.fps);
  return {
    width: clip.width,
    height: clip.height,
    fps: clip.fps,
    chunks: out.map((c, i) => ({
      type: c.type,
      data: c.data,
      timestamp: i * dur,
      duration: dur,
    })),
  };
}

export interface Player {
  stop(): void;
  /** Resolves when a single (non-looping) pass has finished rendering. */
  finished: Promise<void>;
}

/**
 * Decode a (moshed) chunk stream and paint it to a canvas, paced by chunk
 * timestamps. The decoder happily applies delta frames against mismatched
 * references — that corruption is the whole point.
 */
export function play(canvas: HTMLCanvasElement, clip: CapturedClip, loop: boolean): Player {
  canvas.width = clip.width;
  canvas.height = clip.height;
  const ctx = canvas.getContext("2d")!;

  let stopped = false;
  let raf = 0;
  let decoder: VideoDecoder | null = null;
  let queue: VideoFrame[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));

  const cleanupPass = () => {
    for (const f of queue) f.close();
    queue = [];
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
  };

  const runPass = () => {
    if (stopped) return;
    let flushed = false;
    let feed = 0;
    const dec = new VideoDecoder({
      output: (frame) => queue.push(frame),
      // Moshed streams are corrupt by design; if the decoder gives up
      // mid-stream, just end the pass instead of surfacing an error.
      error: () => {
        flushed = true;
      },
    });
    decoder = dec;
    dec.configure({ codec: "vp8", optimizeForLatency: true });

    const pump = () => {
      while (feed < clip.chunks.length && dec.state === "configured" && dec.decodeQueueSize < 8 && queue.length < 8) {
        const c = clip.chunks[feed++];
        dec.decode(
          new EncodedVideoChunk({
            type: c.type,
            timestamp: c.timestamp,
            duration: c.duration,
            data: c.data as BufferSource,
          }),
        );
        if (feed === clip.chunks.length) {
          dec.flush().then(
            () => (flushed = true),
            () => (flushed = true),
          );
        }
      }
    };

    const t0 = performance.now();
    const firstTs = clip.chunks[0]?.timestamp ?? 0;

    const tick = () => {
      if (stopped) return;
      pump();
      const elapsed = (performance.now() - t0) * 1000; // µs
      while (queue.length > 0 && queue[0].timestamp - firstTs <= elapsed) {
        const frame = queue.shift()!;
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
      }
      if (flushed && queue.length === 0 && feed >= clip.chunks.length) {
        cleanupPass();
        if (loop) runPass();
        else resolveFinished();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  runPass();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      cleanupPass();
      resolveFinished();
    },
    finished,
  };
}
