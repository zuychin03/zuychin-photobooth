import type { EventExportGuestbook } from "./guestbook-contract";
import { EventExportError, sameExportMedia, type EventExportClient } from "./export-client";
import { type EventExportEntry, type EventExportFailure, type EventExportPage, type EventExportSummary, type EventExportUpdate } from "./export-contract";
import { eventZipPhotoName, writeEventExportZip, type EventZipPhoto } from "./export-zip";

export interface PreparedEventExportBatch { notes?: { index: number; value: EventExportGuestbook }[]; blob: Blob; filename: string; eventId: string; exportId: string; generation: number; after: number; nextCursor: number | null; summary: EventExportSummary; included: EventExportEntry[]; failures: { index: number; submissionId: string; reason: EventExportFailure }[] }
let preparing = false;
const code = (error: unknown) => error instanceof EventExportError ? error.code : "download_failed";
const stopCodes = new Set(["identity_changed", "cancelled", "access_denied", "expired", "rate_limited", "busy"]);
export async function recheckEventExportBatch(client: EventExportClient, batch: Pick<PreparedEventExportBatch, "eventId" | "exportId" | "generation" | "included" | "after" | "notes">, signal?: AbortSignal) {
  client.assertActive(signal);
  const page = await client.page(batch.eventId, batch.exportId, batch.generation, batch.after, 10, signal); client.assertActive(signal);
  if (page.summary.eventId !== batch.eventId || page.summary.exportId !== batch.exportId || page.summary.generation !== batch.generation) throw new EventExportError("invalid_response");
  if (Date.parse(page.summary.expiresAt) <= Date.now()) throw new EventExportError("expired");
  for (const entry of batch.included) {
    client.assertActive(signal);
    if (!sameExportMedia(await client.access(batch.eventId, batch.exportId, batch.generation, entry.index, signal), entry)) throw new EventExportError("access_denied");
  }
  for (const note of batch.notes ?? []) {
    const current = await client.guestbook(batch.eventId, batch.exportId, batch.generation, note.index, signal);
    if (JSON.stringify(current) !== JSON.stringify(note.value)) throw new EventExportError("access_denied");
  }
  client.assertActive(signal);
  return page;
}
export async function prepareEventExportBatch(client: EventExportClient, eventId: string, exportId: string, generation: number, after = -1, options: { signal?: AbortSignal; onProgress?(complete: number, total: number): void } = {}): Promise<PreparedEventExportBatch> {
  if (preparing) throw new EventExportError("busy"); preparing = true;
  const notes: NonNullable<PreparedEventExportBatch["notes"]> = [];
  const photos: EventZipPhoto[] = [], included: EventExportEntry[] = [], failures: PreparedEventExportBatch["failures"] = [];
  try {
    const page: EventExportPage = await client.page(eventId, exportId, generation, after, 10, options.signal); client.assertActive(options.signal);
    for (const entry of page.entries) {
      client.assertActive(options.signal);
      if (!entry.media) failures.push({ index: entry.index, submissionId: entry.submissionId, reason: "unavailable" });
      else {
        try { const bytes = await client.download(eventId, exportId, generation, entry, options.signal); photos.push({ index: entry.index, submissionId: entry.submissionId, bytes }); included.push(entry); }
        catch (error) { const reason = code(error); if (stopCodes.has(reason)) throw error; failures.push({ index: entry.index, submissionId: entry.submissionId, reason: reason === "integrity_failed" ? reason : "download_failed" }); }
      }
      if (entry.guestbookRevision !== undefined) {
        const note = await client.guestbook(eventId, exportId, generation, entry.index, options.signal);
        if (note.submissionId !== entry.submissionId || note.revision !== entry.guestbookRevision) throw new EventExportError("invalid_response");
        notes.push({ index: entry.index, value: note });
      }
      options.onProgress?.(included.length + failures.length, page.entries.length);
    }
    await recheckEventExportBatch(client, { eventId, exportId, generation, included, after, notes }, options.signal);
    const manifest = { version: 1, eventId, exportId, generation, snapshotCreatedAt: page.summary.createdAt, retainedUntil: page.summary.expiresAt, afterSubmissionId: page.summary.afterSubmissionId, nextSubmissionCursor: page.summary.nextSubmissionCursor, batchAfter: after, nextBatchCursor: page.nextCursor, entries: page.entries.map(entry => ({ index: entry.index, submissionId: entry.submissionId, createdAt: entry.createdAt, expiresAt: entry.expiresAt, caption: null, captionStatus: entry.captionStatus, guestbook: notes.find(n => n.index === entry.index)?.value ?? { status: "not_collected" }, file: included.some(x => x.index === entry.index) ? eventZipPhotoName(entry.index, entry.submissionId) : null, media: entry.media ? { mime: entry.media.mime, bytes: entry.media.bytes, width: entry.media.width, height: entry.media.height, sha256: entry.media.sha256 } : null })) };
    const notesText = notes.filter(n => n.value.status === "available").map(({ value }) => `Submission ${value.submissionId} (text revision ${value.revision})\nSignature: ${value.note!.signature}\n${value.note!.message}\n${value.note!.mission ? `Mission: ${value.note!.mission.label}\nReceipt ready: ${value.note!.missionCompleted ? "yes" : "no"}\n` : ""}`).join("\n---\n");
    const blob = writeEventExportZip(photos, manifest, { version: 1, failures, guestbookFailures: notes.filter(n => n.value.status === "unavailable").map(n => ({ index: n.index, submissionId: n.value.submissionId, revision: n.value.revision, reason: "unavailable" })) }, notesText); client.assertActive(options.signal);
    const updates: EventExportUpdate[] = page.entries.filter(entry => entry.progress.status !== "confirmed_saved").map(entry => {
      const failure = failures.find(x => x.index === entry.index); return { index: entry.index, status: failure ? "failed" : "prepared", error: failure?.reason ?? null };
    });
    const summary = updates.length ? await client.checkpoint(eventId, exportId, generation, page.summary.revision, updates, options.signal) : page.summary;
    await recheckEventExportBatch(client, { eventId, exportId, generation, included, after, notes }, options.signal);
    return { notes, blob, filename: `event-${eventId}-export-${exportId}-g${generation}-batch-${String(after + 1).padStart(3, "0")}.zip`, eventId, exportId, generation, after, nextCursor: page.nextCursor, summary, included, failures };
  } finally { for (const photo of photos) photo.bytes.fill(0); preparing = false; }
}
export async function confirmEventExportSaved(client: EventExportClient, batch: PreparedEventExportBatch, signal?: AbortSignal) {
  client.assertActive(signal);
  const page = await recheckEventExportBatch(client, batch, signal);
  if (!batch.included.length) return page.summary;
  const updates: EventExportUpdate[] = batch.included.filter(entry => page.entries.find(current => current.index === entry.index)?.progress.status !== "confirmed_saved").map(entry => ({ index: entry.index, status: "confirmed_saved", error: null }));
  return updates.length ? client.checkpoint(batch.eventId, batch.exportId, batch.generation, page.summary.revision, updates, signal) : page.summary;
}
