import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertLocalOrigin, assertLoopbackBindings, localEnvironment, LOCAL_RECEIPTS, removeLocalRuntimeFiles } from "./local-supabase-prepare.mjs";

test("localhost setup refuses remote, credentials, paths and non-loopback published ports", () => {
  assert.equal(assertLocalOrigin("http://127.0.0.1:55431"), "http://127.0.0.1:55431");
  for (const origin of ["https://example.com", "http://localhost:55431", "http://user:secret@127.0.0.1:55431", "http://127.0.0.1:55431/auth", "http://127.0.0.1:55431?x=y"]) assert.throws(() => assertLocalOrigin(origin));
  const descriptor = ip => [{ Name: "owned", NetworkSettings: { Ports: { "8000/tcp": [{ HostIp: ip, HostPort: "55431" }], "5432/tcp": null } } }];
  assert.doesNotThrow(() => assertLoopbackBindings(descriptor("127.0.0.1")));
  for (const ip of ["0.0.0.0", "::", "", "192.168.1.5"]) assert.throws(() => assertLoopbackBindings(descriptor(ip)));
});
test("local subprocess environment excludes hosted account and application credentials", () => {
  const env = localEnvironment({ PATH: "safe", TEMP: "temporary", SUPABASE_ACCESS_TOKEN: "private", NEXT_PUBLIC_SUPABASE_URL: "https://remote", SUPABASE_SERVICE_ROLE_KEY: "private", NODE_OPTIONS: "bad", OPENAI_API_KEY: "private" });
  assert.equal(env.PATH, "safe"); assert.equal(env.DOCKER_CONTEXT, "desktop-linux"); assert.equal(env.SUPABASE_TELEMETRY_DISABLED, "1");
  for (const key of ["SUPABASE_ACCESS_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NODE_OPTIONS", "OPENAI_API_KEY"]) assert.equal(env[key], undefined);
});
test("cleanup retains only explicit receipts and removes credentials, scripts and nested caches", async () => {
  const path = join(await realpath(tmpdir()), `pb-local-supabase-${randomBytes(5).toString("hex")}`);
  await mkdir(path);
  try {
    await assert.rejects(removeLocalRuntimeFiles(path));
    await writeFile(join(path, "local-supabase-owner.json"), JSON.stringify({ version: 1, kind: "photobooth-local-supabase", projectId: basename(path), workdir: path }));
    for (const name of [...LOCAL_RECEIPTS, "connection.json", "synthetic-users.private.json", "event-lifecycle.private.json", "startup.private.log", "extra.private.json", "check.mjs"]) await writeFile(join(path, name), "{}");
    await mkdir(join(path, "supabase"));
    await writeFile(join(path, "supabase", "config.toml"), "synthetic fixture");
    await removeLocalRuntimeFiles(path);
    assert.deepEqual((await readdir(path)).sort(), [...LOCAL_RECEIPTS].sort());
  } finally { await rm(path, { recursive: true, force: true }); }
});
