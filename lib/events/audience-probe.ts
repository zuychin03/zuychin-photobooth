import { createEventAudienceClient } from "./audience-client";
import { createEventAudienceFixture } from "./audience-fixture";
import { createEventAudienceLifecycle } from "./audience-lifecycle";

export async function runEventAudienceProbe() {
  if (process.env.NODE_ENV !== "development" || typeof document === "undefined") throw new Error("Development browser required");
  const checks: string[] = [], fixture = await createEventAudienceFixture({ appOrigin: location.origin }), make = (destination: "gallery" | "wall") => createEventAudienceClient({ appOrigin: location.origin, storageOrigin: location.origin, eventId: fixture.eventId, destination, fetch: fixture.fetch });
  const gallery = make("gallery"), wall = make("wall"); let lifecycle: ReturnType<typeof createEventAudienceLifecycle> | undefined;
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message); };
  const waitFor = async (condition: () => boolean, milliseconds: number) => { const end = performance.now() + milliseconds; while (!condition()) { if (performance.now() >= end) throw new Error("Native audience check timed out"); await new Promise(resolve => setTimeout(resolve, 30)); } };
  try {
    await gallery.exchange(fixture.tokens.gallery); let denied = false; try { await wall.session(); } catch { denied = true; } assert(denied, "Gallery session does not open the wall");
    await wall.exchange(fixture.tokens.wall); const page = await gallery.list(), wallPage = await wall.list(); assert(page.entries.length === 4 && wallPage.entries.length === 3, "All four consent combinations and three-wall-item limit");
    const original = await gallery.download(page.entries[0], "image"), thumbnail = await wall.download(wallPage.entries[0], "thumbnail"); assert(original.type === "image/jpeg" && thumbnail.size <= 100000, "Native JPEG decode, dimensions and SHA verification");
    const created = new Set<string>(), revoked = new Set<string>();
    lifecycle = createEventAudienceLifecycle(wall, () => {}, { now: Date.now, schedule: (f, ms) => setTimeout(f, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), createUrl: blob => { const url = URL.createObjectURL(blob); created.add(url); return url; }, revokeUrl: url => { revoked.add(url); URL.revokeObjectURL(url); } });
    lifecycle.start(); await waitFor(() => lifecycle!.getState().images.length === 3, 8000); const began = performance.now(); fixture.hideFirstWall(true); await waitFor(() => !lifecycle!.getState().images.some(item => item.submissionId === wallPage.entries[0].submissionId), 10000); assert(performance.now() - began <= 10000 && revoked.size >= 1, "Withdrawal clears the displayed image within ten seconds");
    lifecycle.pause("offline"); assert(lifecycle.getState().images.length === 0 && created.size === revoked.size, "Offline pause releases every thumbnail URL");
    fixture.replaceSession("gallery"); denied = false; try { await gallery.list(); } catch { denied = true; } assert(denied, "Same-event cookie replacement rejects the old client");
    return { checks, checkedAt: new Date().toISOString() };
  } catch (error) { throw new Error(`After ${checks.length} checks: ${error instanceof Error ? error.message : "audience check failed"}`); }
  finally { lifecycle?.close(); gallery.close(); wall.close(); fixture.close(); }
}
