"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { openAccountCloudRuntime, type AccountCloudRuntime } from "@/lib/projects/cloud-runtime";

export function useCloudRuntime(ownerId: string) {
  const [state, setState] = useState<{ ownerId: string; runtime: AccountCloudRuntime | null; error: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    let handle: ReturnType<typeof openAccountCloudRuntime> | undefined;
    try {
      const auth = createClient();
      handle = openAccountCloudRuntime({
        ownerId, appOrigin: location.origin, storageOrigin: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin,
        accessToken: async () => {
          const result = await auth.auth.getSession();
          return !result.error && result.data.session?.user.id === ownerId ? result.data.session.access_token : null;
        },
        subscribe: listener => {
          const result = auth.auth.onAuthStateChange((_event, session) => listener(session?.user.id ?? null));
          return () => result.data.subscription.unsubscribe();
        },
        onInvalidated: () => { if (active) setState({ ownerId, runtime: null, error: true }); },
      });
      void handle.ready.then(runtime => { runtime.client.assertActive(); if (active) setState({ ownerId, runtime, error: false }); }).catch(() => { if (active) setState({ ownerId, runtime: null, error: true }); });
    } catch { queueMicrotask(() => { if (active) setState({ ownerId, runtime: null, error: true }); }); }
    return () => { active = false; handle?.close(); };
  }, [ownerId]);
  return state?.ownerId === ownerId ? state : { ownerId, runtime: null, error: false };
}
