"use client";

import { Suspense, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { roomEntryRoute } from "@/lib/rtc/entry-v2";
import LegacyRoom from "@/components/rooms/LegacyRoom";
import RoomEntry from "@/components/rooms/RoomEntry";
import RoomWorkspace from "@/components/rooms/RoomWorkspace";

function RoomLoading() {
  return <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-12"><p role="status">Opening room…</p></main>;
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
