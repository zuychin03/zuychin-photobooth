import test from "node:test";
import assert from "node:assert/strict";
import { eventInvitationSvg, eventInvitationUrl } from "../lib/events/invitation";
import type { EventInvitationAudience } from "../lib/events/invitation";

const eventId = "50000000-0000-4000-8000-000000000010", token = "A".repeat(43);
test("invitation QR keeps authority in the fragment and rejects foreign paths or malformed scope", async () => {
  const url = new URL(eventInvitationUrl("https://booth.example", eventId, token));
  assert.equal(url.pathname, `/events/${eventId}/join`); assert.equal(url.search, ""); assert.equal(url.hash, `#invite=${token}`);
  for (const origin of ["https://booth.example/path", "https://user:pass@booth.example", "http://booth.example", "javascript:alert(1)"]) assert.throws(() => eventInvitationUrl(origin, eventId, token));
  assert.throws(() => eventInvitationUrl("https://booth.example", "../other", token));
  assert.throws(() => eventInvitationUrl("https://booth.example", eventId, `${"A".repeat(42)}B`));
  const svg = await eventInvitationSvg("https://booth.example", eventId, token);
  assert.match(svg, /width="512" height="512"/); assert.match(svg, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(svg, /<script|<image|href=|foreignObject/); assert.ok(svg.length < 100000);
});

test("audience QR links retain distinct gallery and wall paths with fragment-only authority", async () => {
  for (const audience of ["gallery", "wall"] as const) {
    const url = new URL(eventInvitationUrl("https://booth.example", eventId, token, audience));
    assert.equal(url.pathname, `/e/${eventId}/${audience}`); assert.equal(url.hash, `#token=${token}`); assert.equal(url.search, "");
    const svg = await eventInvitationSvg("https://booth.example", eventId, token, audience);
    assert.ok(svg.length < 100000); assert.doesNotMatch(svg, /<script|<image|href=|foreignObject/);
  }
  assert.throws(() => eventInvitationUrl("https://booth.example", eventId, token, "../join" as EventInvitationAudience));
});
