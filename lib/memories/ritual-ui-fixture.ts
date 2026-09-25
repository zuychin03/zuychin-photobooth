import { createRitualClient } from "./ritual-client";
import { computeRitualProof, validateRitualEdit, validateRitualInput, type RitualChannels, type RitualDefinition, type RitualRow } from "./ritual-contract";
import { ritualFields, reviewRitual } from "./ritual-editor";

export const ritualFixtureCouple = "20000000-0000-4000-8000-000000000001";
const people = ["20000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000003"];
type Stored = { row: RitualRow; channels: Map<string, RitualChannels>; original: string };
export function createRitualUIFixture(origin: string) {
  const rows = new Map<string, Stored>(); let failure: "before" | "after" | null = null, paired = true, epoch = 0;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  const seed = (id: string, title: string, legacy: boolean, failed = false) => {
    const input = reviewRitual({ ...ritualFields(undefined), title }, new Date().toISOString()).input;
    const next = computeRitualProof(input.schedule, new Date().toISOString()).occurrence!;
    rows.set(id, { row: { id, coupleId: ritualFixtureCouple, creatorId: people[0], title, revision: legacy ? 0 : 2, legacy, scheduledAt: legacy ? tomorrow : next.instant, cadence: legacy ? "once" : "weekly", active: legacy, schedule: legacy ? null : input.schedule, next: legacy ? null : next, paused: false, enabled: !legacy && !failed, channels: { email: false, push: false }, ...(legacy ? {} : { delivery: { status: failed ? "uncertain" : "idle", attempts: failed ? 5 : 0 } as const }) }, channels: new Map(), original: JSON.stringify(input) });
  };
  seed("20000000-0000-4000-8000-000000000010", "Our existing photo date", true);
  seed("20000000-0000-4000-8000-000000000011", "Sunday catch-up", false);
  seed("20000000-0000-4000-8000-000000000012", "Delivery needs attention", false, true);
  const mount = (person: 0 | 1) => {
    const ownerId = people[person]; let identity: { ownerId: string; epoch: number } | null = { ownerId, epoch: ++epoch };
    const project = (stored: Stored) => structuredClone({ ...stored.row, channels: stored.channels.get(ownerId) ?? { email: false, push: false } });
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    // Rehearsal state exercises the real client and UI; SQL remains authoritative.
    const transport: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (failure === "before") { failure = null; throw new Error("synthetic offline"); }
      if (!paired || body.coupleId !== ritualFixtureCouple) return response({ error: "access_denied" }, 403);
      const operation = body.operation;
      if (operation === "ritualList") {
        const items = [...rows.values()].sort((a, b) => a.row.id.localeCompare(b.row.id)).filter(value => !body.after || value.row.id > String(body.after)).slice(0, Number(body.limit ?? 20)).map(project);
        return response({ version: 1, items, nextCursor: items.length === Number(body.limit ?? 20) ? items.at(-1)!.id : null });
      }
      let stored = rows.get(String(body.id));
      const result = (() => {
        if (operation === "ritualCreate") {
          const input = validateRitualInput(body.input); stored = rows.get(input.id);
          if (stored) return stored.row.creatorId === ownerId && stored.original === JSON.stringify({ title: input.title, schedule: input.schedule }) ? response(project(stored)) : response({ error: "conflict" }, 409);
          if (rows.size >= 20) return response({ error: "capacity" }, 409);
          const next = computeRitualProof(input.schedule, new Date().toISOString()).occurrence; if (!next) return response({ error: "no_future_occurrence" }, 409);
          stored = { row: { id: input.id, coupleId: ritualFixtureCouple, creatorId: ownerId, title: input.title, revision: 0, legacy: false, scheduledAt: next.instant, cadence: input.schedule.frequency, active: false, schedule: input.schedule, next, paused: false, enabled: true, channels: { email: false, push: false }, delivery: { status: "idle", attempts: 0 } }, channels: new Map(), original: JSON.stringify({ title: input.title, schedule: input.schedule }) }; rows.set(input.id, stored); return response(project(stored));
        }
        if (!stored || operation !== "ritualSetChannels" && stored.row.creatorId !== ownerId) return response({ error: "access_denied" }, 403);
        const row = stored.row;
        if (operation === "ritualUpgrade" ? !row.legacy || row.scheduledAt !== body.expectedScheduledAt : row.revision !== body.revision) return response({ error: "conflict" }, 409);
        if (operation === "ritualDelete") { rows.delete(row.id); return response({ id: row.id, deleted: true, revision: row.revision + 1 }); }
        if (operation !== "ritualUpgrade" && row.legacy) return response({ error: "access_denied" }, 403);
        if (operation === "ritualEdit" || operation === "ritualUpgrade") {
          const input = validateRitualEdit(body.input), next = computeRitualProof(input.schedule, new Date().toISOString()).occurrence;
          if (operation === "ritualUpgrade" && !next) return response({ error: "no_future_occurrence" }, 409);
          Object.assign(row, { title: input.title, schedule: input.schedule, cadence: input.schedule.frequency, legacy: false, active: false, next, enabled: Boolean(next) && !row.paused, scheduledAt: next?.instant ?? row.scheduledAt, delivery: { status: "idle", attempts: 0 } });
        } else if (operation === "ritualPause") Object.assign(row, { paused: true, enabled: false, delivery: { status: "idle", attempts: 0 } });
        else if (operation === "ritualResume") {
          const next = computeRitualProof(row.schedule as RitualDefinition, new Date().toISOString()).occurrence;
          Object.assign(row, { paused: false, next, enabled: Boolean(next), scheduledAt: next?.instant ?? row.scheduledAt, delivery: { status: "idle", attempts: 0 } });
        } else if (operation === "ritualSetChannels") stored.channels.set(ownerId, body.channels as RitualChannels);
        else return response({ error: "invalid_request" }, 400);
        row.revision++; return response(project(stored));
      })();
      if (failure === "after") { failure = null; throw new Error("synthetic lost acknowledgement"); }
      return result;
    };
    const client = createRitualClient({ appOrigin: origin, identity: () => identity, accessToken: async () => "synthetic-ritual-token", fetch: transport });
    return { client, ownerId, name: person === 0 ? "Alex" : "Bao", close() { identity = null; client.close(); } };
  };
  return { mount, failNext(value: "before" | "after") { failure = value; }, unpair() { paired = false; } };
}
