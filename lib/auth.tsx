"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "@supabase/supabase-js";
import { createClient, hasSupabase } from "./supabase/client";
import { removeLocalAccountCopies, type AccountCleanupResult } from "./projects/account-cleanup";
import { discardProjectEditorRecoveryScope } from "./projects/editor-queue";
import { removeLocalAccountTemplates } from "./templates/account-cleanup";
import { closeRoomScope } from "./rtc/scope-lifecycle";
import { removeLocalAccountRoomData, type RoomCleanupResult } from "./rtc/local-cleanup";
import { removeCloudUploadJournalForOwner } from "./projects/cloud-upload-journal";
import { cleanupSignedOutAccount } from "./projects/signout-cleanup";

export interface SignOutResult {
  localCopies: "kept" | "removed";
  cleanup: AccountCleanupResult | null;
  cleanupError: boolean;
  roomCleanup?: RoomCleanupResult;
}

interface AuthValue {
  user: User | null;
  loading: boolean;
  enabled: boolean;
  signOut: (options?: { removeLocalCopies?: boolean }) => Promise<SignOutResult>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, accountsEnabled = true }: { children: React.ReactNode; accountsEnabled?: boolean }) {
  const enabled = accountsEnabled && hasSupabase();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(enabled);
  const authEpoch = useRef(0);
  const currentOwner = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    const token = authEpoch.current;
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (active && token === authEpoch.current) { currentOwner.current = data.user?.id ?? null; setUser(data.user); }
    }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const previousOwner = currentOwner.current;
      if (previousOwner && previousOwner !== session?.user.id) void closeRoomScope({ kind: "account", ownerId: previousOwner }).catch(() => {});
      authEpoch.current++;
      currentOwner.current = session?.user.id ?? null;
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [enabled]);

  const value = useMemo<AuthValue>(
    () => ({
      user: enabled ? user : null,
      loading: enabled && loading,
      enabled,
      signOut: async (options = {}) => {
        const ownerId = user?.id;
        if (ownerId && currentOwner.current !== ownerId) throw new Error("The active account changed. Reopen the sign-out options.");
        authEpoch.current++;
        const { error } = await createClient().auth.signOut();
        if (error) throw new Error("Sign-out could not be confirmed. No local drafts were removed. Please try again.");
        if (currentOwner.current !== null && currentOwner.current !== ownerId) throw new Error("The active account changed. No local drafts were removed.");
        currentOwner.current = null;
        setUser(null);
        const result: SignOutResult = { localCopies: options.removeLocalCopies && ownerId ? "removed" : "kept", cleanup: null, cleanupError: false };
        if (options.removeLocalCopies && ownerId) {
          Object.assign(result, await cleanupSignedOutAccount({
            rooms: () => removeLocalAccountRoomData(ownerId),
            drainEditors: async () => { await closeRoomScope({ kind: "account", ownerId }); await discardProjectEditorRecoveryScope({ kind: "account", ownerId }); },
            projects: () => removeLocalAccountCopies(ownerId),
            templates: () => removeLocalAccountTemplates(ownerId),
            uploads: () => removeCloudUploadJournalForOwner(ownerId),
          }));
          if (!result.cleanupError && result.cleanup?.retained === 0) {
            try { localStorage.removeItem(`pb-active-project:${ownerId}`); } catch { /* The absent draft is safe even if its stale pointer remains. */ }
          }
        }
        return result;
      },
    }),
    [user, loading, enabled],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
