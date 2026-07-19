// Live webcam datamoshing: camera → VP8 encoder → bitstream interception →
// VP8 decoder → canvas. After the first keyframe the encoder only ever emits
// P-frames, so quantization drift and motion smear accumulate on screen until
// you ask for a resync. Bloom re-feeds the last P-frame so its motion vectors
// pile up; drop discards P-frames so reality jumps when you let go.

// MediaStreamTrackProcessor is Chromium-only and missing from lib.dom.
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor:
  | (new (init: { track: MediaStreamTrack }) => TrackProcessor)
  | undefined;

export interface LiveController {
  setBloom(on: boolean): void;
  setDrop(on: boolean): void;
  /** Force a keyframe through: the picture snaps back to reality. */
  resync(): void;
  startRecording(): void;
  /** Resolves with the recorded video, or null if nothing was recorded. */
  stopRecording(): Promise<Blob | null>;
  stop(): void;
}

const FRAME_US = 33_333;

export async function startLive(canvas: HTMLCanvasElement, bitrate: number): Promise<LiveController> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  const width = Math.max(2, Math.floor((settings.width ?? 1280) / 2) * 2);
  const height = Math.max(2, Math.floor((settings.height ?? 720) / 2) * 2);

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  let stopped = false;
  let bloom = false;
  let drop = false;
  let wantKey = true; // ask the encoder for a keyframe on the next frame
  let passKey = true; // let the next keyframe through to the decoder
  let lastDelta: Uint8Array | null = null;
  let outTs = 0;

  const makeDecoder = () =>
    new VideoDecoder({
      output: (frame) => {
        if (!stopped) ctx.drawImage(frame, 0, 0, width, height);
        frame.close();
      },
      // A corrupt-by-design stream can still push the decoder over the edge;
      // recover by rebuilding it and forcing a resync.
      error: () => {
        if (stopped) return;
        decoder = makeDecoder();
        decoder.configure({ codec: "vp8", optimizeForLatency: true });
        wantKey = true;
        passKey = true;
      },
    });
  let decoder = makeDecoder();
  decoder.configure({ codec: "vp8", optimizeForLatency: true });

  const feed = (type: "key" | "delta", data: Uint8Array) => {
    if (decoder.state !== "configured") return;
    outTs += FRAME_US;
    decoder.decode(
      new EncodedVideoChunk({ type, timestamp: outTs, data: data as BufferSource }),
    );
  };

  const encoder = new VideoEncoder({
    output: (chunk) => {
      if (stopped) return;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (chunk.type === "key") {
        // Suppress every keyframe except the ones explicitly requested —
        // this is what keeps the picture moshing instead of self-correcting.
        if (!passKey) return;
        passKey = false;
        lastDelta = null;
        feed("key", data);
        return;
      }
      if (bloom && lastDelta) {
        feed("delta", lastDelta); // re-apply the same motion, again and again
        return;
      }
      if (drop) return; // let reality drift ahead of the picture
      lastDelta = data;
      feed("delta", data);
    },
    error: () => {
      /* camera went away mid-encode; stop() handles teardown */
    },
  });
  encoder.configure({
    codec: "vp8",
    width,
    height,
    bitrate,
    framerate: 30,
    latencyMode: "realtime",
  });

  const encodeFrame = (frame: VideoFrame) => {
    if (!stopped && encoder.state === "configured" && encoder.encodeQueueSize < 4) {
      encoder.encode(frame, { keyFrame: wantKey });
      wantKey = false;
    }
    frame.close();
  };

  // Frame source: MediaStreamTrackProcessor where available (Chromium),
  // otherwise a hidden <video> sampled via requestVideoFrameCallback.
  let stopSource: () => void;
  if (typeof MediaStreamTrackProcessor !== "undefined") {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let reading = true;
    (async () => {
      while (reading) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        encodeFrame(value);
      }
    })();
    stopSource = () => {
      reading = false;
      reader.cancel().catch(() => {});
    };
  } else {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    let ts = 0;
    const onFrame = () => {
      if (stopped) return;
      encodeFrame(new VideoFrame(video, { timestamp: (ts += FRAME_US) }));
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => {});
    stopSource = () => {
      video.srcObject = null;
    };
  }

  let recorder: MediaRecorder | null = null;
  let recorded: BlobPart[] = [];

  return {
    setBloom(on) {
      bloom = on;
    },
    setDrop(on) {
      drop = on;
    },
    resync() {
      wantKey = true;
      passKey = true;
    },
    startRecording() {
      if (recorder) return;
      recorded = [];
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) =>
        MediaRecorder.isTypeSupported(m),
      );
      recorder = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recorded.push(e.data);
      };
      recorder.start(250);
    },
    stopRecording() {
      return new Promise((resolve) => {
        const r = recorder;
        recorder = null;
        if (!r) {
          resolve(null);
          return;
        }
        r.onstop = () => resolve(new Blob(recorded, { type: r.mimeType || "video/webm" }));
        r.stop();
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopSource();
      recorder?.stop();
      recorder = null;
      for (const t of stream.getTracks()) t.stop();
      if (encoder.state !== "closed") encoder.close();
      if (decoder.state !== "closed") decoder.close();
    },
  };
}
