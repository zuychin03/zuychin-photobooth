"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { EventPostcardComposer } from "@/components/events/EventPostcardComposer";
import { renderRoomPostcard, roomPostcardPlan } from "@/lib/rtc/postcard-render";
import type { RoomWorkspaceController } from "@/lib/rtc/workspace-controller";
import type { TemplateDesign } from "@/lib/templates/model";

export function RoomPostcard({ controller, disabled, databaseName, onBusyChange }: { controller: RoomWorkspaceController; disabled: boolean; databaseName?: string; onBusyChange(busy: boolean): void }) {
  const { user } = useAuth(), life = useRef<AbortController | null>(null);
  let plan: ReturnType<typeof roomPostcardPlan> | null = null, problem: string | null = null;
  try { plan = roomPostcardPlan(controller.getSnapshot()); } catch (error) { problem = error instanceof Error ? error.message : "The complete shared capture is unavailable."; }
  const fingerprint = plan?.fingerprint;
  useEffect(() => {
    life.current = new AbortController();
    const hide = () => { life.current?.abort(); if (!document.hidden) life.current = new AbortController(); };
    document.addEventListener("visibilitychange", hide);
    return () => { life.current?.abort(); document.removeEventListener("visibilitychange", hide); onBusyChange(false); };
  }, [controller, fingerprint, user?.id, onBusyChange]);
  const assertActive = useCallback((signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!life.current || life.current.signal.aborted || document.hidden || controller.scope.kind === "account" && controller.scope.ownerId !== user?.id || roomPostcardPlan(controller.getSnapshot()).fingerprint !== fingerprint) throw new Error("The room or account changed. Reopen this postcard from the current complete capture.");
  }, [controller, fingerprint, user?.id]);
  if (!plan) return <p className="mt-5 text-sm leading-relaxed text-muted-foreground">{problem}</p>;
  const render = async (signal: AbortSignal, design: TemplateDesign) => {
    assertActive(signal);
    return renderRoomPostcard({ initial: plan, current: controller.getSnapshot, design, signal: AbortSignal.any([signal, life.current!.signal]), assertActive, databaseName });
  };
  return <div className="mt-5">
    {plan.design.look.sceneId && <p className="text-sm leading-relaxed text-muted-foreground">This postcard uses the separate original photos in your split layout. Together background cutouts are not applied.</p>}
    <EventPostcardComposer key={fingerprint} source={plan.source} design={plan.design} render={render} assertSourceActive={assertActive} disabled={disabled} onBusyChange={onBusyChange} />
  </div>;
}
