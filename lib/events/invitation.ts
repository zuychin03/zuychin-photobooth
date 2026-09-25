import { toString } from "qrcode";

export type EventInvitationAudience = "guest" | "gallery" | "wall";

export function eventInvitationUrl(origin: string, eventId: string, token: string, audience: EventInvitationAudience = "guest"): string {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || origin.length > 300 || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(eventId) || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) throw new Error("Invalid event invitation");
  if (!["guest", "gallery", "wall"].includes(audience)) throw new Error("Invalid event audience");
  return audience === "guest" ? `${url.origin}/events/${eventId}/join#invite=${token}` : `${url.origin}/e/${eventId}/${audience}#token=${token}`;
}

export async function eventInvitationSvg(origin: string, eventId: string, token: string, audience: EventInvitationAudience = "guest"): Promise<string> {
  return toString(eventInvitationUrl(origin, eventId, token, audience), { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 512, color: { dark: "#000000", light: "#ffffffff" } });
}
