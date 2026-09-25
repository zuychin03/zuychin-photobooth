import { cloudUuid } from "../projects/cloud-contract";
import type { CloudIdentity } from "../projects/cloud-client";
import type { MemoryRuntimeOptions } from "./memory-runtime";
import { createVoiceClient } from "./voice-client";
import { openVoiceDraftJournal } from "./voice-drafts";

export interface VoiceRuntime { client: ReturnType<typeof createVoiceClient>; journal: Awaited<ReturnType<typeof openVoiceDraftJournal>> }
export interface VoiceRuntimePorts { client: typeof createVoiceClient; journal: typeof openVoiceDraftJournal }
export type VoiceRuntimeOptions = Omit<MemoryRuntimeOptions, "storageOrigin">;
let nextEpoch = 0;
export function openVoiceRuntime(options: VoiceRuntimeOptions, ports: VoiceRuntimePorts = { client: createVoiceClient, journal: openVoiceDraftJournal }) {
  const ownerId = cloudUuid(options.ownerId);
  let identity: CloudIdentity | null = { ownerId, epoch: ++nextEpoch }, stopped = false, unsubscribe: (() => void) | undefined;
  let client: VoiceRuntime["client"] | undefined, journal: VoiceRuntime["journal"] | undefined;
  const close = () => {
    if (stopped) return;
    stopped = true; identity = null;
    try { unsubscribe?.(); } finally { try { client?.close(); } finally { journal?.close(); } }
  };
  const ready = Promise.resolve().then(async (): Promise<VoiceRuntime> => {
    try {
      if (stopped) throw new Error("cancelled");
      unsubscribe = options.subscribe(current => { if (current !== ownerId && !stopped) { close(); options.onInvalidated?.(); } });
      if (stopped) { unsubscribe(); throw new Error("account_changed"); }
      const account = { appOrigin: options.appOrigin, identity: () => identity, accessToken: options.accessToken };
      client = ports.client(account);
      if (stopped) { client.close(); throw new Error("account_changed"); }
      journal = await ports.journal(ownerId, { identity: () => identity });
      if (stopped) { journal.close(); throw new Error("account_changed"); }
      client.assertActive(); journal.assertActive();
      return { client, journal };
    } catch (error) { close(); throw error; }
  });
  return { ready, close };
}
