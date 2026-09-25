import { eventClientUuid } from "./client";
import { parsePostcardSource, type PostcardSource } from "./postcard-contract";
import { postcardOrigin } from "./postcard-transport";

export function postcardReferenceUrl(origin: string, eventId: string, postcardId: string, source: PostcardSource): string {
  const checked = parsePostcardSource(source), url = new URL(`${postcardOrigin(origin)}/e/${eventClientUuid(eventId)}/postcard`);
  url.searchParams.set("postcard", eventClientUuid(postcardId)); url.searchParams.set("kind", checked.kind); url.searchParams.set("source", checked.id);
  if (checked.kind === "room") url.searchParams.set("capture", checked.captureId);
  return url.href;
}
export function parsePostcardReference(value: string, origin: string) {
  if (value.length > 1000) throw new Error("Invalid postcard link");
  const url = new URL(value), path = /^\/e\/([a-f0-9-]{36})\/postcard$/.exec(url.pathname);
  if (url.origin !== postcardOrigin(origin) || url.username || url.password || url.hash || !path || [...url.searchParams.keys()].sort().join() !== (url.searchParams.get("kind") === "room" ? "capture,kind,postcard,source" : "kind,postcard,source")) throw new Error("Invalid postcard link");
  return { eventId: eventClientUuid(path[1]), postcardId: eventClientUuid(url.searchParams.get("postcard")), source: parsePostcardSource({ kind: url.searchParams.get("kind"), id: url.searchParams.get("source"), ...(url.searchParams.has("capture") ? { captureId: url.searchParams.get("capture") } : {}) }) };
}
export function parsePostcardInvitation(value: string, origin: string): { eventId: string; token: string } {
  if (value.length > 1000) throw new Error("Paste an event invitation from this app");
  const url = new URL(value), path = /^\/events\/([a-f0-9-]{36})\/join$/.exec(url.pathname), fragment = new URLSearchParams(url.hash.slice(1)), token = fragment.get("invite");
  if (url.origin !== postcardOrigin(origin) || url.username || url.password || url.search || !path || [...fragment.keys()].join() !== "invite" || !token || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) throw new Error("Paste an event invitation from this app");
  return { eventId: eventClientUuid(path[1]), token };
}
export function postcardNonce() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
