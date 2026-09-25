import test from "node:test";
import assert from "node:assert/strict";
import { createSignaling } from "../lib/rtc/signaling";
import { RoomEngine, type RoomEngineEvents } from "../lib/rtc/engine";

test("development legacy transport forces isolated BroadcastChannels despite configured hosting and supplies no ICE servers", async () => {
  const environment = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY }, priorPeer = globalThis.RTCPeerConnection;
  Object.assign(process.env, { NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://must-not-contact.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-value" });
  let configuration: RTCConfiguration | undefined, foreignMessages = 0;
  let created!: () => void; const ready = new Promise<void>(resolve => { created = resolve; });
  class Peer { constructor(config: RTCConfiguration) { configuration = config; created(); } async setRemoteDescription() {} async createAnswer() { return { type: "answer", sdp: "synthetic" }; } async setLocalDescription() {} close() {} }
  globalThis.RTCPeerConnection = Peer as unknown as typeof RTCPeerConnection;
  const callbacks: RoomEngineEvents = { onStatus() {}, onRoster() {}, onRemoteStream() {}, onScene() {}, onArm() {}, onRemoteFrame() {}, onPeerLeft() {} };
  const room = `fixture-${crypto.randomUUID()}`, engine = new RoomEngine(room, false, callbacks, true), sender = createSignaling(room, true), foreign = createSignaling(`${room}-other`, true);
  foreign.onMessage(() => foreignMessages++);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    sender.send({ type: "offer", from: "synthetic-host", payload: { role: "A", sdp: { type: "offer", sdp: "synthetic" } } });
    await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Local transport did not deliver")), 2000); })]);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(configuration, { iceServers: [] }); assert.equal(foreignMessages, 0);
    engine.close(); assert.doesNotThrow(() => engine.close());
  } finally { if (timer) clearTimeout(timer); engine.close(); sender.close(); foreign.close(); globalThis.RTCPeerConnection = priorPeer; for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test("production rejects the explicit rehearsal transport before opening a channel", () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "production" });
  try { assert.throws(() => createSignaling("ABC234", true), /requires development/); }
  finally { if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});
