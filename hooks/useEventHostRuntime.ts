"use client";
import type { EventReminderClient } from "@/lib/events/reminder-client";
import type { EventModerationClient } from "@/lib/events/moderation-client";
import type { EventExportClient } from "@/lib/events/export-client";
import type { EventReviewClient } from "@/lib/events/review-client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { openEventHostRuntime } from "@/lib/events/host-runtime";
import type { EventHostClient } from "@/lib/events/client";

export function useEventHostRuntime(ownerId: string) {
  const [state, setState] = useState<{ ownerId: string; client: EventHostClient | null; exportClient?: EventExportClient; reviewClient?: EventReviewClient; reminderClient?: EventReminderClient; moderationClient?: EventModerationClient; error: boolean } | null>(null);
  useEffect(() => {
    let live = true, handle: ReturnType<typeof openEventHostRuntime> | undefined;
    void Promise.resolve().then(async () => {
      if (!live) return;
      const auth = createClient();
      handle = openEventHostRuntime({ ownerId, appOrigin: location.origin, storageOrigin: process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin : undefined,
        accessToken: async () => { const result = await auth.auth.getSession(); return !result.error && result.data.session?.user.id === ownerId ? result.data.session.access_token : null; },
        subscribe: listener => { const result = auth.auth.onAuthStateChange((_event, session) => listener(session?.user.id ?? null)); return () => result.data.subscription.unsubscribe(); },
        onInvalidated: () => { if (live) setState({ ownerId, client: null, error: true }); },
      });
      const client = await handle.ready; client.assertActive(); if (live) setState({ ownerId, client, exportClient: handle.exportClient, reviewClient: handle.reviewClient, reminderClient: handle.reminderClient, moderationClient: handle.moderationClient, error: false });
    }).catch(() => { handle?.close(); if (live) setState({ ownerId, client: null, error: true }); });
    return () => { live = false; handle?.close(); };
  }, [ownerId]);
  return state?.ownerId === ownerId ? state : { ownerId, client: null, error: false };
}
