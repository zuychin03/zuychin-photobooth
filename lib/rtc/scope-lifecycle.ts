import type { ProjectScope } from "../projects/model";

const closers = new Map<string, Set<() => void | Promise<void>>>(), epochs = new Map<string, number>();
export function roomScopeKey(scope: ProjectScope): string {
  if (scope.kind === "device") return "device";
  if (scope.kind === "account" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(scope.ownerId)) return `account:${scope.ownerId}`;
  throw new Error("room_scope_invalid");
}
export const roomScopeEpoch = (scope: ProjectScope) => epochs.get(roomScopeKey(scope)) ?? 0;
export function registerRoomScopeCloser(scope: ProjectScope, close: () => void | Promise<void>): () => void {
  const key = roomScopeKey(scope), entries = closers.get(key) ?? new Set(); entries.add(close); closers.set(key, entries);
  return () => { entries.delete(close); if (!entries.size) closers.delete(key); };
}
export async function closeRoomScope(scope: ProjectScope): Promise<void> {
  const key = roomScopeKey(scope); epochs.set(key, (epochs.get(key) ?? 0) + 1);
  const pending: Promise<void>[] = [];
  for (const close of [...closers.get(key) ?? []]) { try { pending.push(Promise.resolve(close())); } catch (error) { pending.push(Promise.reject(error)); } }
  const results = await Promise.allSettled(pending);
  if (results.some(result => result.status === "rejected")) throw new Error("room_scope_close_failed");
}
export async function withRoomScopeLock<T>(scope: ProjectScope, work: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) return Promise.reject(new Error("room_scope_lock_unavailable"));
  return await navigator.locks.request(`photobooth-room-scope:${roomScopeKey(scope)}`, { mode: "exclusive" }, work);
}
