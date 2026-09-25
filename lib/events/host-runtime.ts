import { createEventReminderClient, type EventReminderClient } from "./reminder-client";
import { createEventExportClient, type EventExportClient } from "./export-client";
import { createEventHostClient, type EventHostClient, type EventHostClientOptions } from "./client";
import { createEventReviewClient, type EventReviewClient } from "./review-client";
import { createEventModerationClient, type EventModerationClient } from "./moderation-client";

export interface EventHostRuntimeOptions {
  ownerId: string; appOrigin: string; storageOrigin?: string; accessToken(): Promise<string | null>;
  subscribe(listener: (ownerId: string | null) => void): () => void;
  onInvalidated?(): void;
}
let epoch = 0;
export function openEventHostRuntime(options: EventHostRuntimeOptions, factory: (options: EventHostClientOptions) => EventHostClient = createEventHostClient) {
  let identity: { ownerId: string; epoch: number } | null = { ownerId: options.ownerId, epoch: ++epoch }, closed = false;
  let reminderClient: EventReminderClient | undefined;
  let moderationClient: EventModerationClient | undefined;
  let exportClient: EventExportClient | undefined, reviewClient: EventReviewClient | undefined;
  let client: EventHostClient | undefined, unsubscribe: (() => void) | undefined;
  const close = () => { if (closed) return; closed = true; identity = null; client?.close(); exportClient?.close(); reviewClient?.close(); reminderClient?.close(); moderationClient?.close(); unsubscribe?.(); };
  const ready = Promise.resolve().then(() => {
    if (closed) throw new Error("cancelled");
    try {
      unsubscribe = options.subscribe(owner => { if (!closed && owner !== options.ownerId) { close(); options.onInvalidated?.(); } });
      if (closed) { unsubscribe(); throw new Error("identity_changed"); }
      client = factory({ appOrigin: options.appOrigin, identity: () => identity, accessToken: options.accessToken });
      if (closed) { client.close(); throw new Error("identity_changed"); }
      client.assertActive();
      if (options.storageOrigin) exportClient = createEventExportClient({ appOrigin: options.appOrigin, storageOrigin: options.storageOrigin, identity: () => identity, accessToken: options.accessToken });
      if (options.storageOrigin) reviewClient = createEventReviewClient({ appOrigin: options.appOrigin, storageOrigin: options.storageOrigin, identity: () => identity, accessToken: options.accessToken });
      reminderClient = createEventReminderClient({ appOrigin: options.appOrigin, identity: () => identity, accessToken: options.accessToken });
      moderationClient = createEventModerationClient({ appOrigin: options.appOrigin, identity: () => identity, accessToken: options.accessToken });
      return client;
    } catch (error) { close(); throw error; }
  });
  return { ready, close, get reminderClient() { return reminderClient; }, get moderationClient() { return moderationClient; }, get exportClient() { return exportClient; }, get reviewClient() { return reviewClient; } };
}
