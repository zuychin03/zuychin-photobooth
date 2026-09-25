import type { AccountCleanupResult } from "./account-cleanup";
import type { RoomCleanupResult } from "../rtc/local-cleanup";

export interface SignOutCleanupPorts {
  rooms(): Promise<RoomCleanupResult>;
  drainEditors(): Promise<void>;
  projects(): Promise<AccountCleanupResult>;
  templates(): Promise<AccountCleanupResult>;
  uploads(): Promise<{ removed: number }>;
}

export async function cleanupSignedOutAccount(ports: SignOutCleanupPorts) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => ports.rooms()),
    Promise.resolve().then(async () => { await ports.drainEditors(); return ports.projects(); }),
    Promise.resolve().then(() => ports.templates()),
    Promise.resolve().then(async () => ({ removed: (await ports.uploads()).removed, retained: 0, incomplete: false })),
  ]);
  const cleanup: AccountCleanupResult = { removed: 0, retained: 0, incomplete: false };
  let cleanupError = false;
  const [rooms, ...copies] = results;
  if (rooms.status === "rejected") { cleanupError = true; cleanup.incomplete = true; }
  for (const result of copies) {
    if (result.status === "rejected") { cleanupError = true; cleanup.incomplete = true; }
    else {
      cleanup.removed += result.value.removed;
      cleanup.retained += result.value.retained;
      cleanup.incomplete ||= result.value.incomplete;
    }
  }
  return { cleanup, cleanupError, ...(rooms.status === "fulfilled" ? { roomCleanup: rooms.value } : {}) };
}
