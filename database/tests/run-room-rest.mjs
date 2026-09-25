import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { createServer } from "node:http";
import { createRoomHandler, isRoomAction } from "../../lib/server/room-requests.ts";

const network = `pb-v2-room-rest-${randomBytes(5).toString("hex")}`, database = `${network}-db`, api = `${network}-api`;
const jwtSecret = randomBytes(32).toString("hex"), created = [];
let networkCreated = false, bridge;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const command = async (args, input) => { const result = await docker(args, input); if (result.code) throw new Error(result.stderr.slice(-4000)); return result.stdout.trim(); };
const sql = source => command(["exec", "-i", database, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], source);
const token = role => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const content = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${content}.${createHmac("sha256", jwtSecret).update(content).digest("base64url")}`;
};

try {
  await command(["network", "create", network]); networkCreated = true;
  await command(["run", "--detach", "--name", database, "--network", network, "--memory", "512m", "--cpus", "2", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16-alpine"]); created.push(database);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if ((await docker(["exec", database, "pg_isready", "-U", "postgres"])).code === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready);
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql(await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/003_v2_rooms.sql", import.meta.url), "utf8");
  await sql(migration); await sql(migration);
  await sql(`CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role' $$;
CREATE ROLE pb_room_rest_auth LOGIN NOINHERIT; GRANT anon,authenticated,service_role TO pb_room_rest_auth;`);
  const port = await new Promise((resolve, reject) => { const server = netServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); }); });
  await command(["run", "--detach", "--name", api, "--network", network, "--memory", "256m", "--cpus", "1", "--publish", `127.0.0.1:${port}:3000`, "--env", `PGRST_DB_URI=postgres://pb_room_rest_auth@${database}:5432/postgres`, "--env", "PGRST_DB_ANON_ROLE=anon", "--env", `PGRST_JWT_SECRET=${jwtSecret}`, "postgrest/postgrest:v14.16"]); created.push(api);
  const binding = JSON.parse(await command(["inspect", "--format", "{{json .HostConfig.PortBindings}}", api]));
  assert.deepEqual(binding["3000/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(port) }]);
  const restOrigin = `http://127.0.0.1:${port}`, serviceToken = token("service_role");
  const rest = (path, role = "service_role", body) => fetch(restOrigin + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${role === "service_role" ? serviceToken : token(role)}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  ready = false;
  for (let i = 0; i < 40; i++) { try { if ((await rest("/rpc/pb_room_capabilities", "service_role", {})).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 200)); }
  assert(ready);
  assert([401, 403].includes((await rest("/pb_rooms", "authenticated")).status));
  assert([401, 403, 404].includes((await rest("/rpc/pb_room_call", "authenticated", { p_room_id: randomUUID(), p_hash: "a".repeat(64), p_action: "state" })).status));

  let origin = "";
  const environment = () => ({ NODE_ENV: "development", PB_ROOM_V2_ENABLED: "true", PB_ROOM_RATE_SECRET: jwtSecret, NEXT_PUBLIC_SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: serviceToken });
  bridge = createServer(async (incoming, outgoing) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of incoming) { size += chunk.length; if (size > 65536) { outgoing.writeHead(413).end(); return; } chunks.push(chunk); }
      const body = Buffer.concat(chunks), headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
      let response;
      if (incoming.url.startsWith("/rest/v1/")) {
        response = await fetch(restOrigin + incoming.url.slice("/rest/v1".length), { method: incoming.method, headers, ...(body.length ? { body } : {}), signal: AbortSignal.timeout(10000) });
      } else {
        const request = new Request(origin + incoming.url, { method: incoming.method, headers, ...(body.length ? { body } : {}) });
        const parts = incoming.url.split("/").filter(Boolean);
        const operation = parts.length === 2 ? "create" : parts[2] === "join" || parts[2] === "capabilities" ? parts[2] : parts[3];
        assert(["create", "join", "capabilities"].includes(operation) || isRoomAction(operation));
        response = await createRoomHandler(operation, undefined, environment)(request, parts.length === 4 ? parts[2] : undefined);
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500).end("fixture adapter failure"); }
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${bridge.address().port}`;
  const client = () => ({ cookies: new Map() });
  const send = async (identity, path, body) => {
    const roomId = /^\/api\/rooms\/([^/]+)\//.exec(path)?.[1];
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", cookie: identity.cookies.get(roomId) ?? "" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) });
    const cookie = response.headers.get("set-cookie"), data = await response.json();
    if (cookie) { const room = /Path=\/api\/rooms\/([^;]+)/.exec(cookie)?.[1]; identity.cookies.set(room, cookie.split(";")[0]); }
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return { status: response.status, data };
  };
  const host = client(), other = client(), guests = Array.from({ length: 8 }, client);
  const a = await send(host, "/api/rooms", { displayName: "Host A" }), b = await send(other, "/api/rooms", { displayName: "Host B" });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const room = a.data.roomId, path = action => `/api/rooms/${room}/${action}`;
  const joins = await Promise.all(guests.map((guest, index) => send(guest, "/api/rooms/join", { code: a.data.code, displayName: `Guest ${index}` })));
  assert(joins.every(reply => reply.status === 201)); assert(joins.every(reply => reply.data.members.length === 1));
  const admitted = await Promise.all(joins.map(reply => send(host, path("admit"), { memberId: reply.data.selfId })));
  assert.equal(admitted.filter(reply => reply.status === 200).length, 3);
  const accepted = guests.filter((_guest, index) => admitted[index].status === 200), pending = guests.find((_guest, index) => admitted[index].status !== 200);
  const states = await Promise.all(accepted.map(guest => send(guest, path("state"), {})));
  assert(states.every(reply => reply.status === 200 && reply.data.selfRole));
  assert.equal((await send(pending, path("poll"), { cursor: 0 })).status, 403);
  const peer = accepted[0], state = states[0].data;
  const signal = { messageId: randomUUID(), toMemberId: a.data.selfId, connectionEpoch: state.connectionEpoch, kind: "sdp", payload: JSON.stringify({ type: "offer", sdp: "fixture" }) };
  assert.equal((await send(peer, path("signal"), signal)).status, 200);
  assert.equal((await send(peer, path("signal"), signal)).status, 200);
  assert.equal((await send(host, path("poll"), { cursor: 0 })).data.signals.length, 1);
  assert.equal((await send(other, `/api/rooms/${b.data.roomId}/poll`, { cursor: 0 })).data.signals.length, 0);
  assert.equal((await send(peer, path("lock"), { locked: true })).status, 403);
  const snapshot = (await send(host, path("state"), {})).data;
  const proposal = { captureId: randomUUID(), rosterRevision: snapshot.rosterRevision, recipeHash: "b".repeat(64), shotIds: ["one"], fireAt: Date.now() + 25000, intervalMs: 1000, profile: { maxPhotoBytes: 1048576, maxPhotoPixels: 1048576, shotsPerMember: 1 } };
  assert.equal((await send(host, path("prepare"), proposal)).status, 200);
  assert.equal((await send(host, path("commit"), { captureId: proposal.captureId })).data.error, "not_ready");
  const ack = { captureId: proposal.captureId, rosterRevision: proposal.rosterRevision, recipeHash: proposal.recipeHash };
  const acks = await Promise.all([host, ...accepted].map(identity => send(identity, path("ack"), ack))); assert(acks.every(reply => reply.status === 200));
  const commits = await Promise.all(Array.from({ length: 6 }, () => send(host, path("commit"), { captureId: proposal.captureId })));
  assert(commits.every(reply => reply.status === 200 && reply.data.state === "committed"));
  assert.equal((await send(peer, path("capture"), { captureId: proposal.captureId, peerId: a.data.selfId })).status, 200);
  assert.equal((await send(host, path("remove"), { memberId: state.selfId })).status, 200);
  assert.equal((await send(host, path("capture"), { captureId: proposal.captureId, peerId: state.selfId })).status, 403);
  assert.equal((await send(peer, path("state"), {})).status, 403);
  assert.equal((await send(peer, path("signal"), { ...signal, messageId: randomUUID() })).status, 403);
  assert.equal((await send(host, path("end"), {})).status, 200);
  assert.equal((await send(accepted[1], path("state"), {})).status, 403);
  console.log("PostgREST 14.16 + actual Supabase RPC adapter + loopback room HTTP handlers passed: cookie admission/exchange, eight admissions/three seats, two-room isolation, sender binding, signal deduplication, host-only control, all-member acknowledgements, six idempotent commits, removal and room end.");
  console.log("The bridge adapts /rest/v1 to PostgREST; this is not hosted Supabase, HTTPS-browser cookie, TURN or real-device evidence.");
} finally {
  if (bridge) { bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); }
  for (const name of created.reverse()) await command(["rm", "--force", "--volumes", name]);
  if (networkCreated) await command(["network", "rm", network]);
}
