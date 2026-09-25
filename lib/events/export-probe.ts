import { createEventExportFixture } from "./export-fixture";
import { createEventExportClient } from "./export-client";
import { prepareEventExportBatch, confirmEventExportSaved } from "./export-coordinator";

export async function runEventExportProbe() {
  const checks: { name: string; passed: boolean; detail?: string }[] = [], canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 60;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable"); ctx.fillStyle = "#c54d6d"; ctx.fillRect(0, 0, 80, 60);
  const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("JPEG encoding unavailable")), "image/jpeg", 0.8)); canvas.width = canvas.height = 1;
  const eventId = crypto.randomUUID(), ownerId = crypto.randomUUID(), exportId = crypto.randomUUID(), appOrigin = location.origin, storageOrigin = "https://synthetic-event-export.invalid";
  const fixture = await createEventExportFixture({ appOrigin, storageOrigin, eventId, ownerId, image }), client = createEventExportClient({ appOrigin, storageOrigin, ...fixture });
  try {
    fixture.loseCreate(); try { await client.create(eventId, exportId); } catch { /* Simulated lost acknowledgement. */ }
    const created = await client.create(eventId, exportId); checks.push({ name: "Exact snapshot retry retains one server record", passed: (await client.list(eventId)).exports.length === 1 });
    const batch = await prepareEventExportBatch(client, eventId, exportId, created.generation);
    checks.push({ name: "Native JPEG decode, SHA verification and bounded ZIP", passed: batch.included.length === 9 && batch.failures.length === 1 && batch.blob.type === "application/zip" && batch.blob.size < 20135168, detail: `${batch.blob.size} bytes; nine real decoded synthetic JPEGs and one failed-item report.` });
    const header = new DataView(await batch.blob.slice(0, 4).arrayBuffer()); checks.push({ name: "Standard ZIP local-file signature", passed: header.getUint32(0, true) === 0x04034b50 });
    checks.push({ name: "Prepared status does not claim saved", passed: (await client.page(eventId, exportId, 0)).entries[0].progress.status === "prepared" });
    await confirmEventExportSaved(client, batch); checks.push({ name: "Explicit saved confirmation survives fresh read", passed: (await client.page(eventId, exportId, 0)).entries[0].progress.status === "confirmed_saved" });
    const next = await prepareEventExportBatch(client, eventId, exportId, 0, batch.nextCursor!); checks.push({ name: "Second batch resumes remaining two originals", passed: next.included.length === 2 && next.nextCursor === null });
    fixture.revoke(); let denied = false; try { await client.access(eventId, exportId, 0, 0); } catch { denied = true; } checks.push({ name: "Revoked export authority blocks re-read", passed: denied });
    return { checks, passed: checks.every(x => x.passed), testedAt: new Date().toISOString() };
  } finally { client.close(); }
}
