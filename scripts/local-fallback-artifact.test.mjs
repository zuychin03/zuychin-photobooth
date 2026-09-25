import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundedFiles, fallbackEnvironment, freezeFallback, materialiseFallback, verifyFallback } from "./local-fallback-artifact.mjs";

async function fixture(run) {
  const base = await mkdtemp(join(tmpdir(), "pb-artifact-test-")), source = join(base, "source"), destination = join(base, "artifact");
  try {
    for (const path of [".next/cache", ".next/dev", "public", "node_modules/test", ".git"]) await mkdir(join(source, path), { recursive: true });
    for (const [path, bytes] of Object.entries({ ".next/BUILD_ID": "test-build", ".next/server.js": "production", ".next/cache/cache": "skip", ".next/dev/dev": "skip", "public/sw.js": "worker", "node_modules/test/index.js": "dependency", "node_modules/test/.env": "SECRET=not-copied", ".git/config": "private", ".env.local": "API_KEY=private-value-12345", "package.json": "{}", "package-lock.json": "{}", "next.config.ts": "export default {}", "tsconfig.json": "{}", "next-env.d.ts": "", "node-fixture": "synthetic-node" })) await writeFile(join(source, path), bytes);
    await run({ source, destination, nodeExecutable: join(source, "node-fixture"), env: {} });
  } finally { await rm(base, { recursive: true, force: true }); }
}
test("snapshot excludes env, Git and mutable build caches; verifies all dependencies and refuses overwrite", () => fixture(async options => {
  const frozen = await freezeFallback(options), manifest = await verifyFallback(options.destination);
  assert.equal(manifest.integrity, frozen.integrity); assert(manifest.files.some(file => file.path === "node_modules/test/index.js"));
  assert(!manifest.files.some(file => /\.env|\.git|\.next\/(cache|dev)/.test(file.path)));
  await assert.rejects(freezeFallback(options));
  await writeFile(join(options.destination, "public/sw.js"), "tampered"); await assert.rejects(verifyFallback(options.destination), /checksum mismatch/);
}));
test("extra unlisted files and malicious inventory paths cannot launch", () => fixture(async options => {
  await freezeFallback(options); await writeFile(join(options.destination, "unexpected.txt"), "unexpected");
  await assert.rejects(verifyFallback(options.destination), /inventory changed/);
  const path = join(options.destination, "fallback-manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.files[0].path = "../escape"; await writeFile(path, JSON.stringify(manifest)); await assert.rejects(verifyFallback(options.destination), /manifest/);
}));
test("known private build material fails before a completed artifact manifest exists", () => fixture(async options => {
  await writeFile(join(options.source, ".next/server.js"), "compiled private-value-12345");
  await assert.rejects(freezeFallback(options), /Private environment material/);
  await assert.rejects(readFile(join(options.destination, "fallback-manifest.json")));
}));
test("snapshot cannot overlap source and runtime environment excludes credentials and Node injection", () => fixture(async options => {
  await assert.rejects(freezeFallback({ ...options, destination: join(options.source, "artifact") }), /outside/);
  const env = fallbackEnvironment({ PATH: "system-path", SUPABASE_SERVICE_ROLE_KEY: "private", NODE_OPTIONS: "--import=bad", PB_EVENTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://remote.invalid" });
  assert.equal(env.PATH, "system-path"); assert.equal(env.PB_EVENTS_ENABLED, "false"); assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, undefined);
}));
test("a junction parent cannot conceal a destination inside source", () => fixture(async options => {
  const alias = join(options.destination, "../source-alias"); await symlink(options.source, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(freezeFallback({ ...options, destination: join(alias, "nested") }), /outside/);
}));
test("runtime copy is reverified after an artifact changes following initial verification", () => fixture(async options => {
  await freezeFallback(options); const m = await verifyFallback(options.destination);
  await writeFile(join(options.destination, "public/sw.js"), "changed-before-copy");
  await assert.rejects(materialiseFallback(options.destination, m), /checksum mismatch/);
}));
test("quoted and unquoted dotenv comments cannot hide compiled private material", () => fixture(async options => {
  await writeFile(join(options.source, ".env.local"), 'API_KEY="private-value-12345" # comment\nOTHER_SECRET=second-private-value # comment');
  await writeFile(join(options.source, ".next/server.js"), "compiled private-value-12345");
  await assert.rejects(freezeFallback(options), /Private environment material/);
}));
test("Turbopack dependency aliases are materialised but aliases outside installed dependencies are refused", () => fixture(async options => {
  await mkdir(join(options.source, ".next/node_modules"));
  await symlink(join(options.source, "node_modules/test"), join(options.source, ".next/node_modules/test-alias"), process.platform === "win32" ? "junction" : "dir");
  await freezeFallback(options); const manifest = await verifyFallback(options.destination);
  assert(manifest.files.some(file => file.path === ".next/node_modules/test-alias/index.js"));
  await symlink(join(options.source, "public"), join(options.source, ".next/node_modules/outside-alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(freezeFallback({ ...options, destination: options.destination + "-second" }), /Symbolic link refused/);
}));
test("bounded file failures stop new work but retain the eight occupied operations until all settle", async () => {
  let active = 0, maximum = 0, started = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const work = boundedFiles(Array.from({ length: 30 }, (_, index) => index), async index => { active++; started++; maximum = Math.max(maximum, active); try { if (index === 0) throw new Error("synthetic refusal"); await held; } finally { active--; } });
  let settled = false; const result = work.then(() => { settled = true; }, error => { settled = true; return error; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(settled, false); assert.equal(maximum, 7); assert.equal(started, 8);
  release(); assert.match((await result).message, /synthetic refusal/); assert.equal(active, 0); assert.equal(started, 8);
});
