"use client";

import { Suspense, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { roomEntryRoute } from "@/lib/rtc/entry-v2";
import LegacyRoom from "@/components/rooms/LegacyRoom";
import RoomEntry from "@/components/rooms/RoomEntry";
import RoomWorkspace from "@/components/rooms/RoomWorkspace";

function RoomLoading() {
  return <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-12"><p role="status" className="flex items-center gap-2 text-sm font-bold text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden />Opening room…</p></main>;
}

function RoomRoute() {
  const { code } = useParams<{ code: string }>(), search = useSearchParams();
  const { user, loading } = useAuth();
  const query = search.toString();
  const target = useMemo(() => roomEntryRoute(code, new URLSearchParams(query)), [code, query]);
  if (target.kind === "legacy") return <LegacyRoom />;
  if (loading) return <RoomLoading />;
  const ownerScope = user ? `account:${user.id}` : "device";
  const targetKey = `${target.kind}:${"code" in target ? target.code : ""}:${"roomId" in target ? target.roomId : ""}`;
  return <RoomEntry key={`${ownerScope}:${targetKey}`} target={target} ownerScope={ownerScope} Workspace={RoomWorkspace} />;
}

export default function RoomPage() {
  return <Suspense fallback={<RoomLoading />}><RoomRoute /></Suspense>;
}
