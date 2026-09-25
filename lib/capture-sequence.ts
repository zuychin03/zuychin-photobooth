export interface CaptureSequencePorts<Shot> {
  cancelled(): boolean;
  pause(milliseconds: number): Promise<void>;
  countdown(value: number | null): void;
  beforeShot?(index: number): void;
  capture(): Shot;
  persist(index: number, shot: Shot): Promise<void>;
  saved(index: number, shot: Shot): void;
}

export async function runCaptureSequence<Shot>(indices: readonly number[], timerSeconds: 3 | 5 | 10, ports: CaptureSequencePorts<Shot>): Promise<boolean> {
  try {
    for (const index of indices) {
      if (ports.cancelled()) return false;
      ports.beforeShot?.(index);
      for (let count = timerSeconds; count > 0; count--) {
        if (ports.cancelled()) return false;
        ports.countdown(count);
        await ports.pause(1000);
      }
      ports.countdown(null);
      if (ports.cancelled()) return false;
      const shot = ports.capture();
      await ports.persist(index, shot);
      if (ports.cancelled()) return false;
      ports.saved(index, shot);
      await ports.pause(700);
    }
    return !ports.cancelled();
  } finally { ports.countdown(null); }
}
