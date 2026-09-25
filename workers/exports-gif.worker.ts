import { createMotionGifEncoder, type GifWorkerRequest, type GifWorkerReply } from "../lib/exports/motion-gif-core";

const scope = self as unknown as { onmessage: ((event: MessageEvent<GifWorkerRequest>) => void) | null; postMessage(message: GifWorkerReply, transfer?: Transferable[]): void };
let encoder: ReturnType<typeof createMotionGifEncoder> | undefined;
let failed = false;
scope.onmessage = event => {
  if (failed) return;
  try {
    const message = event.data;
    if (message.type === "init") {
      if (encoder) throw new Error("GIF encoder already started");
      encoder = createMotionGifEncoder(message.width, message.height, message.delayMs, message.frameCount);
      scope.postMessage({ type: "ready" });
    } else if (!encoder) throw new Error("GIF encoder is not ready");
    else if (message.type === "frame") {
      encoder.write(new Uint8Array(message.pixels), message.index);
      scope.postMessage({ type: "frame", index: message.index });
    } else if (message.type === "finish") {
      const result = encoder.finish();
      scope.postMessage({ type: "done", bytes: result.bytes.buffer, durationMs: result.durationMs }, [result.bytes.buffer]);
      encoder = undefined;
    } else throw new Error("Unexpected GIF worker message");
  } catch (error) {
    failed = true; encoder = undefined;
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "GIF encoding failed" });
  }
};
