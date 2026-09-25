import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AccessDenied, Capabilities, MINUTE, RoomSignalling } from "../lib/feasibility/access-model";

async function readSignal(request: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 40_000) throw new AccessDenied("body too large");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccessDenied("invalid body");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || ["sender", "recipient", "kind", "payload"].some(key => typeof record[key] !== "string")) throw new AccessDenied("invalid body");
  return record as { sender: string; recipient: string; kind: string; payload: string };
}

test("loopback HTTP send/poll isolates two rooms and rejects forged, removed, expired and revoked tokens", async () => {
  let time = 1_000;
  const caps = new Capabilities(() => time);
  const rooms = new RoomSignalling(caps, () => time);
  for (const room of ["first", "second"]) rooms.create(room, ["host", "guest"], time + 60 * MINUTE);
  const issue = (resource: string, subject: string, duration = 60 * MINUTE) => caps.issue({ scope: "room", resource, subject, role: subject === "host" ? "host" : "participant", expiresAt: time + duration });
  const firstHost = issue("first", "host");
  const firstGuest = issue("first", "guest");
  const secondHost = issue("second", "host");
  const secondGuest = issue("second", "guest");
  const expiring = issue("first", "guest", MINUTE);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Type", "application/json");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/rooms\/(first|second)\/signals$/.exec(url.pathname);
      if (!match) throw new AccessDenied("invalid route");
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
      if (!bearer) throw new AccessDenied("missing capability");
      let result: unknown;
      if (request.method === "POST") result = { cursor: rooms.send(bearer, match[1], await readSignal(request)) };
      else if (request.method === "GET") {
        const cursor = url.searchParams.get("after");
        if (cursor === null || !/^\d+$/.test(cursor)) throw new AccessDenied("invalid cursor");
        result = rooms.poll(bearer, match[1], Number(cursor));
      } else throw new AccessDenied("invalid method");
      response.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof AccessDenied || error instanceof SyntaxError ? 403 : 500).end(JSON.stringify({ error: "request denied" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (room: string, token: string, body?: unknown, after = "0") => {
    const response = await fetch(`${base}/rooms/${room}/signals?after=${after}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return { status: response.status, body: await response.json() };
  };
  const signal = { sender: "host", recipient: "guest", kind: "sdp", payload: "first-room-offer" };
  try {
    assert.equal((await request("first", firstHost, signal)).status, 200);
    assert.equal((await request("second", secondHost, { ...signal, payload: "second-room-offer" })).status, 200);
    const first = await request("first", firstGuest);
    const second = await request("second", secondGuest);
    assert.equal(first.body.messages[0].payload, "first-room-offer");
    assert.equal(second.body.messages[0].payload, "second-room-offer");
    assert.deepEqual((await request("first", firstGuest, undefined, String(first.body.cursor))).body.messages, []);
    assert.equal((await request("first", firstGuest, { sender: "guest", recipient: "host", kind: "ice", payload: "candidate" })).status, 200);
    assert.equal((await request("first", firstHost)).body.messages[0].kind, "ice");
    for (const token of [secondGuest, "first", "x".repeat(43)]) {
      assert.equal((await request("first", token)).status, 403);
      assert.equal((await request("first", token, signal)).status, 403);
    }
    assert.equal((await request("first", firstGuest, signal)).status, 403);
    assert.equal((await request("first", firstHost, { ...signal, payload: "x".repeat(40_001) })).status, 403);
    assert.equal((await request("first", firstHost, { ...signal, extra: true })).status, 403);
    assert.equal((await request("first", firstHost, undefined, "NaN")).status, 403);
    time += MINUTE;
    assert.equal((await request("first", expiring)).status, 403);
    assert.equal((await request("first", expiring, { ...signal, sender: "guest", recipient: "host" })).status, 403);
    rooms.remove("first", "guest");
    assert.equal((await request("first", firstGuest)).status, 403);
    assert.equal((await request("first", firstGuest, { ...signal, sender: "guest", recipient: "host" })).status, 403);
    caps.revoke(secondGuest);
    assert.equal((await request("second", secondGuest)).status, 403);
    assert.equal((await request("second", secondHost)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
