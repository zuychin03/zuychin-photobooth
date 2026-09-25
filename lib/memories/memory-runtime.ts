import { cloudUuid } from "../projects/cloud-contract";
import { createCloudProjectClient, type CloudIdentity } from "../projects/cloud-client";
import { createActivityClient } from "./activity-client";
import { createRetainedStripClient } from "./retained-strip-client";

export interface MemoryRuntimeOptions {
  ownerId: string; appOrigin: string; storageOrigin: string;
  accessToken(): Promise<string | null>;
  subscribe(listener: (ownerId: string | null) => void): () => void;
  onInvalidated?(): void;
}
export interface MemoryRuntimePorts { activity: typeof createActivityClient; retained: typeof createRetainedStripClient; projects: typeof createCloudProjectClient }
export interface MemoryRuntime { activity: ReturnType<typeof createActivityClient>; retained: ReturnType<typeof createRetainedStripClient>; projects: ReturnType<typeof createCloudProjectClient> }
let nextEpoch = 0;
export function openMemoryRuntime(options: MemoryRuntimeOptions, ports: MemoryRuntimePorts = { activity: createActivityClient, retained: createRetainedStripClient, projects: createCloudProjectClient }) {
  const ownerId = cloudUuid(options.ownerId);
  let identity: CloudIdentity | null = { ownerId, epoch: ++nextEpoch }, stopped = false, unsubscribe: (() => void) | undefined;
  let activity: MemoryRuntime["activity"] | undefined, retained: MemoryRuntime["retained"] | undefined, projects: MemoryRuntime["projects"] | undefined;
  const close = () => { if (stopped) return; stopped = true; identity = null; unsubscribe?.(); activity?.close(); retained?.close(); projects?.close(); };
  const ready = Promise.resolve().then(() => {
    try {
      if (stopped) throw new Error("cancelled");
      unsubscribe = options.subscribe(current => { if (current !== ownerId && !stopped) { close(); options.onInvalidated?.(); } });
      if (stopped) { unsubscribe(); throw new Error("account_changed"); }
      const account = { appOrigin: options.appOrigin, identity: () => identity, accessToken: options.accessToken };
      activity = ports.activity(account); retained = ports.retained(account); projects = ports.projects({ ...account, storageOrigin: options.storageOrigin });
      activity.assertActive(); retained.assertActive(); projects.assertActive();
      return { activity, retained, projects };
    } catch (error) { close(); throw error; }
  });
  return { ready, close };
}
