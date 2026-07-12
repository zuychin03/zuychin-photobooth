// Signaling carries only SDP/ICE and room hellos, never photo data.
// Supabase Realtime when configured; BroadcastChannel fallback lets two
// tabs on one machine pair up with no backend (local dev).
import { createClient, RealtimeChannel } from "@supabase/supabase-js";

export interface SignalMessage {
  type: "hello" | "roster" | "offer" | "answer" | "ice" | "full" | "bye";
  from: string;
  to?: string;
  payload?: unknown;
}

export interface Signaling {
  send(msg: SignalMessage): void;
  onMessage(cb: (msg: SignalMessage) => void): void;
  close(): void;
}

class SupabaseSignaling implements Signaling {
  private channel: RealtimeChannel;
  private cb: ((msg: SignalMessage) => void) | null = null;
  private queue: SignalMessage[] = [];
  private ready = false;

  constructor(url: string, anonKey: string, roomCode: string) {
    const client = createClient(url, anonKey, {
      realtime: { params: { eventsPerSecond: 20 } },
    });
    this.channel = client.channel(`booth:${roomCode}`, {
      config: { broadcast: { self: false } },
    });
    this.channel
      .on("broadcast", { event: "signal" }, ({ payload }) => {
        this.cb?.(payload as SignalMessage);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          this.ready = true;
          this.queue.forEach((m) => this.send(m));
          this.queue = [];
        }
      });
  }

  send(msg: SignalMessage): void {
    if (!this.ready) {
      this.queue.push(msg);
      return;
    }
    void this.channel.send({ type: "broadcast", event: "signal", payload: msg });
  }

  onMessage(cb: (msg: SignalMessage) => void): void {
    this.cb = cb;
  }

  close(): void {
    void this.channel.unsubscribe();
  }
}

class LocalSignaling implements Signaling {
  private bc: BroadcastChannel;
  private cb: ((msg: SignalMessage) => void) | null = null;

  constructor(roomCode: string) {
    this.bc = new BroadcastChannel(`booth:${roomCode}`);
    this.bc.onmessage = (e) => this.cb?.(e.data as SignalMessage);
  }

  send(msg: SignalMessage): void {
    this.bc.postMessage(msg);
  }

  onMessage(cb: (msg: SignalMessage) => void): void {
    this.cb = cb;
  }

  close(): void {
    this.bc.close();
  }
}

export function createSignaling(roomCode: string): Signaling {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && key) return new SupabaseSignaling(url, key, roomCode);
  return new LocalSignaling(roomCode);
}

export function usingLocalSignaling(): boolean {
  return !(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
