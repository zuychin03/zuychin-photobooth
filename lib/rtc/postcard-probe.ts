import { openProjectRepository } from "../projects/storage";
import { projectBlobHash } from "../projects/bundle";
import { renderRoomPostcard, roomPostcardPlan } from "./postcard-render";
import type { RoomFixturePerson } from "./workspace-fixture";
import type { WorkspaceSnapshot } from "./workspace-controller";

export interface RoomPostcardProbeResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  preview: Blob | null;
}
const colours = [[236, 113, 142], [37, 166, 155], [149, 129, 217], [220, 183, 96]];
let occupied = false;

export async function runRoomPostcardProbe(person: RoomFixturePerson, external?: AbortSignal): Promise<RoomPostcardProbeResult> {
  if (process.env.NODE_ENV !== "development") throw new Error("Room postcard probe is development-only");
  if (occupied) throw new Error("A room postcard probe is still releasing native work.");
  if (!/^pb-room-ui-fixture-[a-f0-9-]+-[0-3]-projects$/.test(person.projectDatabaseName)) throw new Error("An isolated room fixture is required.");
  const initial = roomPostcardPlan(person.controller.getSnapshot()), roles = initial.project.participants.map(person => person.role);
  if (roles.length !== 4 || !["A", "B", "C", "D"].every(role => roles.includes(role as typeof roles[number]))) throw new Error("Complete a four-person capture with all originals before running this probe.");
  if (initial.design.look.filterId !== "none" || initial.design.slots.some(slot => [slot, ...(slot.companions ?? [])].some(source => source.filterId && source.filterId !== "none"))) throw new Error("Choose the Original filter for the fixture colour checks, then run the probe again.");
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ...(external ? [external] : [])]);
  const timer = setTimeout(() => controller.abort(), 90000), checks: RoomPostcardProbeResult["checks"] = [];
  let repository: Awaited<ReturnType<typeof openProjectRepository>> | undefined, preview: Blob | null = null;
  occupied = true;
  const active = () => {
    signal.throwIfAborted();
    if (roomPostcardPlan(person.controller.getSnapshot()).fingerprint !== initial.fingerprint) throw new Error("The fixture changed during the probe. Run it again after the room settles.");
  };
  const run = async (name: string, work: () => Promise<string>) => {
    active();
    try { checks.push({ name, passed: true, detail: await work() }); }
    catch (error) { signal.throwIfAborted(); checks.push({ name, passed: false, detail: error instanceof Error ? error.message : "Probe failed" }); }
  };
  const hashes = async () => {
    active(); const loaded = await repository!.load(initial.project.id); active();
    if (!loaded || loaded.kind !== "current" || JSON.stringify(loaded.project) !== JSON.stringify(initial.project)) throw new Error("The saved fixture project changed.");
    const result: [string, string][] = [];
    for (const [id, blob] of loaded.media) { result.push([id, await projectBlobHash(blob)]); active(); }
    return JSON.stringify(result.sort(([a], [b]) => a.localeCompare(b)));
  };
  const render = (current: () => WorkspaceSnapshot, state: RoomFixturePerson["readState"]) => renderRoomPostcard({ initial, current, design: initial.design, databaseName: person.projectDatabaseName, signal, assertActive: active }, { state: async () => { active(); return state(); } });
  const work = (async () => { try {
    repository = await openProjectRepository(initial.project.scope, { databaseName: person.projectDatabaseName }); active();
    const before = await hashes();
    await run("Native full-original JPEG and four-role pixels", async () => {
      let reads = 0;
      const blob = await render(person.controller.getSnapshot, async () => { reads++; return person.readState(); }); active();
      const bitmap = await createImageBitmap(blob), canvas = document.createElement("canvas"), small = document.createElement("canvas");
      try {
        active(); const size = initial.design.canvas, scale = Math.min(2, 4096 / Math.max(size.width, size.height), Math.sqrt(12000000 / (size.width * size.height)));
        if (bitmap.width !== Math.round(size.width * scale) || bitmap.height !== Math.round(size.height * scale) || reads !== 2) throw new Error("Output dimensions or authority checks differ from the frozen design.");
        canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("Canvas is unavailable."); context.drawImage(bitmap, 0, 0);
        const counts = new Map<string, number>();
        for (const slot of initial.design.slots) {
          const sources = (slot.splitFallback ? [slot, ...(slot.companions ?? [])] : [slot]).sort((a, b) => a.role.localeCompare(b.role));
          sources.forEach((source, index) => {
            let matches = 0; const expected = colours["ABCD".indexOf(source.role)];
            for (let y = 1; y < 10; y++) for (let x = 1; x < 10; x++) {
              const px = Math.floor((slot.x + slot.width * (index + x / 10) / sources.length) * canvas.width), py = Math.floor((slot.y + slot.height * y / 10) * canvas.height), pixel = context.getImageData(px, py, 1, 1).data;
              if (expected.every((value, channel) => Math.abs(value - pixel[channel]) <= 25)) matches++;
            }
            if (matches < 4) throw new Error(`Role ${source.role}, source ${source.sourceIndex + 1}: only ${matches} colour samples match. Use the default separate-photo layout without overlays or aggressive crops.`);
            counts.set(source.role, (counts.get(source.role) ?? 0) + matches);
          });
        }
        if (roles.some(role => !counts.has(role))) throw new Error("A participant is absent from the rendered print.");
        small.width = Math.max(1, Math.round(canvas.width * Math.min(1, 640 / Math.max(canvas.width, canvas.height)))); small.height = Math.max(1, Math.round(canvas.height * small.width / canvas.width)); small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
        preview = await new Promise<Blob>((resolve, reject) => small.toBlob(value => value ? resolve(value) : reject(new Error("Preview encoding failed")), "image/jpeg", .85)); active();
        return `${canvas.width} × ${canvas.height}; ${blob.size} JPEG bytes; ${[...counts].map(([role, count]) => `${role}: ${count} matching samples`).join(", ")}; two fresh authority checks.`;
      } finally { bitmap.close(); canvas.width = canvas.height = small.width = small.height = 0; }
    });
    const refused = async (work: () => Promise<Blob>) => { try { await work(); } catch (error) { if (error instanceof Error && /shared capture|room or account/.test(error.message)) return; throw error; } throw new Error("An invalidated render unexpectedly returned a JPEG."); };
    for (const phase of ["before", "after"] as const) {
      await run(`Removed participant ${phase} composition`, async () => {
        let reads = 0;
        await refused(() => render(person.controller.getSnapshot, async () => {
          const state = await person.readState(); reads++;
          return phase === "before" || reads === 2 ? { ...state, members: state.members.map(member => member.role === "D" ? { ...member, status: "removed" as const } : member) } : state;
        }));
        if (reads !== (phase === "before" ? 1 : 2)) throw new Error("The revocation check ran at an unexpected stage.");
        return "No JPEG was published; the actual room was unchanged.";
      });
      await run(`Changed frozen recipe ${phase} composition`, async () => {
        let changed = phase === "before", reads = 0;
        await refused(() => render(() => { const snapshot = person.controller.getSnapshot(); return changed ? { ...snapshot, recipe: { ...snapshot.recipe!, recipeHash: "0".repeat(64) } } : snapshot; }, async () => { const state = await person.readState(); if (++reads === 2) changed = true; return state; }));
        if (reads !== (phase === "before" ? 0 : 2)) throw new Error("The recipe fence ran at an unexpected stage.");
        return "No JPEG was published; the saved recipe was unchanged.";
      });
    }
    await run("Stored originals and project remain unchanged", async () => { if (await hashes() !== before) throw new Error("A stored original changed."); return `${initial.project.media.length} original digests and the complete saved project match.`; });
    return { passed: checks.every(check => check.passed), checks, preview };
  } finally { clearTimeout(timer); repository?.close(); occupied = false; } })();
  let onAbort = () => {};
  try { return await Promise.race([work, new Promise<never>((_, reject) => { onAbort = () => reject(new DOMException("Room postcard probe cancelled or timed out", "AbortError")); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); })]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
