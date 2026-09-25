import type { RoomCapture } from "../server/room-contract";
import type { TransferJournal } from "./transfer-store";

export type CaptureProgress =
  | { kind: "capture-started"; captureId: string }
  | { kind: "shot-saved"; captureId: string; shotId: string; index: number }
  | { kind: "local-original-saved"; captureId: string; shotId: string; index: number }
  | { kind: "capture-complete"; captureId: string }
  | { kind: "capture-incomplete"; captureId: string; shotId?: string; reason: string };
export class CaptureRunner {
  private controller: AbortController | null = null;
  private seen = new Set<string>();
  constructor(private readonly options: {
    journal: TransferJournal; expiresAt: number; now(): number;
    authorised(capture: RoomCapture): Promise<boolean>;
    capture(capture: RoomCapture, index: number): Promise<void>;
    onProgress(event: CaptureProgress): void;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }) {}
  cancel(reason = "capture_cancelled") { this.controller?.abort(reason); }
  async run(capture: RoomCapture): Promise<void> {
    if (capture.state !== "committed" || this.seen.has(capture.captureId)) return;
    if (this.controller && !this.controller.signal.aborted) throw new Error("capture_already_running");
    this.seen.add(capture.captureId);
    const controller = new AbortController(); this.controller = controller;
    const wait = this.options.wait ?? ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new Error("capture_cancelled")); return; }
      const abort = () => { clearTimeout(timer); reject(new Error("capture_cancelled")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    }));
    let shotId: string | undefined;
    try {
      this.options.onProgress({ kind: "capture-started", captureId: capture.captureId });
      for (let index = 0; index < capture.shotIds.length; index++) {
        shotId = capture.shotIds[index];
        const fireAt = capture.fireAt + index * capture.intervalMs;
        while (fireAt - this.options.now() > 500) await wait(Math.min(200, fireAt - this.options.now() - 500), controller.signal);
        if (controller.signal.aborted || !await this.options.authorised(capture)) throw new Error("capture_authority_lost");
        if (this.options.now() > fireAt + 250) throw new Error("capture_deadline_missed");
        if (!await this.options.journal.claimShot(capture.captureId, shotId, this.options.expiresAt)) throw new Error("capture_already_claimed");
        while (this.options.now() < fireAt) await wait(Math.min(40, fireAt - this.options.now()), controller.signal);
        if (controller.signal.aborted || this.options.now() > fireAt + 250) throw new Error("capture_deadline_missed");
        await this.options.capture(capture, index);
        await this.options.journal.finishShot(capture.captureId, shotId);
        this.options.onProgress({ kind: "shot-saved", captureId: capture.captureId, shotId, index });
        if (controller.signal.aborted) throw new Error("capture_cancelled");
      }
      this.options.onProgress({ kind: "capture-complete", captureId: capture.captureId });
    } catch (error) {
      this.options.onProgress({ kind: "capture-incomplete", captureId: capture.captureId, ...(shotId ? { shotId } : {}), reason: error instanceof Error ? error.message : "capture_failed" });
    } finally { if (this.controller === controller) this.controller = null; }
  }
}
