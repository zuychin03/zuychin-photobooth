"use client";

import { useEffect, useState } from "react";
import { eventControl } from "./EventHostControls";
import type { EventInvitationAudience } from "@/lib/events/invitation";

export function EventInvitationQr({ eventId, token, expiresAt, audience = "guest" }: { eventId: string; token: string; expiresAt: string; audience?: EventInvitationAudience }) {
  return <InvitationQr key={`${eventId}:${audience}:${token}:${expiresAt}`} eventId={eventId} token={token} expiresAt={expiresAt} audience={audience} />;
}

function InvitationQr({ eventId, token, expiresAt, audience }: { eventId: string; token: string; expiresAt: string; audience: EventInvitationAudience }) {
  const label = audience === "guest" ? "invitation" : `${audience} access`;
  const [ready, setReady] = useState<string | null>(null), [failed, setFailed] = useState(false), [expired, setExpired] = useState(() => !Number.isFinite(Date.parse(expiresAt)) || Date.now() >= Date.parse(expiresAt));
  useEffect(() => {
    let active = Number.isFinite(Date.parse(expiresAt)) && Date.now() < Date.parse(expiresAt), url: string | null = null;
    const expiry = Date.parse(expiresAt), check = () => {
      if (Date.now() >= expiry || !Number.isFinite(expiry)) { active = false; if (url) URL.revokeObjectURL(url); url = null; setReady(null); setExpired(true); }
    };
    if (active) void import("@/lib/events/invitation").then(module => module.eventInvitationSvg(location.origin, eventId, token, audience)).then(svg => {
      if (!active) return; check(); if (!active) return;
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); setReady(url);
    }).catch(() => { if (active) setFailed(true); });
    const timer = setInterval(check, 1000);
    return () => { active = false; clearInterval(timer); if (url) URL.revokeObjectURL(url); };
  }, [eventId, token, expiresAt, audience]);
  return <figure className="mt-5 max-w-sm">
    {ready ? <>
      {/* This private SVG stays in the browser and must not pass through image optimisation. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={ready} width={256} height={256} alt={`Private QR ${label} for this event`} className="h-auto w-64 max-w-full rounded-sm bg-white" />
      <a className={`${eventControl} mt-3 border border-border`} href={ready} download={audience === "guest" ? "event-invitation.svg" : `event-${audience}-access.svg`} onClick={event => { if (Date.now() >= Date.parse(expiresAt)) event.preventDefault(); }}>Download QR {label}</a>
    </> : <p role="status" className="text-sm">{expired ? "This link has expired. Create a new link to get a new QR code." : failed ? "The QR code could not be prepared. You can still copy the private link." : `Preparing your QR ${label}…`}</p>}
    <figcaption className="mt-2 text-xs leading-relaxed text-foreground/70">{audience === "guest" ? "Share this code only with your guests. It grants the same access as the private invitation link." : audience === "gallery" ? "Anyone with this code can browse approved gallery photos. It does not allow contributions or wall access." : "Anyone with this code can open the approved event wall. It does not allow contributions or gallery access."}</figcaption>
  </figure>;
}
