import { computeRitualProof, type RitualDefinition, type RitualRow } from "../../lib/memories/ritual-contract";
import type { RitualStore } from "../../lib/server/ritual-store";
export const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const coupleId = id(2), actorId = id(3);
export const env = { PB_MEMORIES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NODE_ENV: "production" };
export const schedule: RitualDefinition = { version: 1, anchorDate: "2030-01-31", localTime: "09:00", timeZone: "Australia/Sydney", frequency: "monthly", interval: 1, invalidDate: "clamp", gap: "shift-forward", fold: "later", onceAt: null };
export const row = (): RitualRow => ({ id: id(), coupleId, creatorId: actorId, title: "Photo date", revision: 0, legacy: false, schedule, next: computeRitualProof(schedule, "2030-02-01T00:00:00Z").occurrence, scheduledAt: "2030-02-27T22:00:00.000Z", cadence: "monthly", active: false, enabled: true, paused: false, channels: { email: false, push: false } });
export function fixtureStore() {
  const calls: unknown[][] = [];
  const store: RitualStore = {
    list: async (...args) => { calls.push(["list", ...args]); return { version: 1, items: [row()], nextCursor: null }; },
    create: async (...args) => { calls.push(["create", ...args]); return row(); },
    upgrade: async (...args) => { calls.push(["upgrade", ...args]); return { ...row(), revision: 1 }; },
    edit: async (...args) => { calls.push(["edit", ...args]); return { ...row(), revision: args[2] + 1, ...args[3] }; },
    pause: async (...args) => { calls.push(["pause", ...args]); return { ...row(), revision: args[2] + 1, paused: true, enabled: false }; },
    resume: async (...args) => { calls.push(["resume", ...args]); return { ...row(), revision: args[2] + 1 }; },
    delete: async (...args) => { calls.push(["delete", ...args]); return { id: args[1], deleted: true, revision: args[2] + 1 }; },
    setChannels: async (...args) => { calls.push(["setChannels", ...args]); return { ...row(), revision: args[2] + 1, channels: args[3] }; },
  };
  return { calls, store };
}
