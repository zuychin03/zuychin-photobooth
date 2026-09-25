"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { FeatureIncoming } from "@/components/FeatureIncoming";
import { useKioskLocked } from "@/components/events/EventKioskGuard";
import { incomingFeature } from "@/lib/release-mode";

const LocalReleaseContext = createContext(false);

export function ReleaseModeProvider({ localOnly, children }: { localOnly: boolean; children: ReactNode }) {
  return <LocalReleaseContext.Provider value={localOnly}>{children}</LocalReleaseContext.Provider>;
}

export function useLocalRelease() { return useContext(LocalReleaseContext); }

export function ReleaseFeatureBoundary({ children }: { children: ReactNode }) {
  const localOnly = useLocalRelease(), pathname = usePathname(), locked = useKioskLocked();
  const feature = incomingFeature(pathname);
  return localOnly && feature && !locked ? <FeatureIncoming feature={feature} /> : children;
}
