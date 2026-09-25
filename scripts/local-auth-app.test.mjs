import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { cleanupLocalApp, copySafeTree, localAppEnvironment, prepareLocalFonts, readLocalConnection, redactLocalLog, requestLocalAppStop, stopOwnedChild } from "./local-auth-app.mjs";

async function fixture() {
  const temp = await realpath(tmpdir()), workdir = join(temp, `pb-local-supabase-${randomBytes(5).toString("hex")}`);
  await mkdir(workdir);
  const data = { supabaseUrl: "http://127.0.0.1:55431", anonKey: "synthetic-anonymous-credential", serviceRoleKey: "synthetic-service-credential", projectId: "photobooth_fixture", workdir };
  await writeFile(join(workdir, "local-supabase-owner.json"), JSON.stringify({ version: 1, kind: "photobooth-local-supabase", projectId: data.projectId, workdir }));
  const file = join(workdir, "connection.json"); await writeFile(file, JSON.stringify(data));
  return { data, file, close: () => rm(workdir, { recursive: true, force: true }) };
}
test("connection requires exact canonical owned fixture and rejects remote/authenticated URLs", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readLocalConnection(f.file), f.data);
    for (const supabaseUrl of ["https://example.com", "http://localhost:55431", "http://user:pass@127.0.0.1:55431", "http://127.0.0.1:55431/path", "http://127.0.0.1:55431?key=secret", "http://127.0.0.1:3010"]) {
      await writeFile(f.file, JSON.stringify({ ...f.data, supabaseUrl })); await assert.rejects(readLocalConnection(f.file));
    }
    await writeFile(f.file, JSON.stringify({ ...f.data, projectId: "another_fixture" })); await assert.rejects(readLocalConnection(f.file), /marker/);
    await writeFile(f.file, JSON.stringify({ ...f.data, workdir: tmpdir() })); await assert.rejects(readLocalConnection(f.file), /owned/);
  } finally { await f.close(); }
});
test("child environment drops inherited secrets, preload hooks and provider destinations", () => {
  const env = localAppEnvironment({ supabaseUrl: "http://127.0.0.1:55431", anonKey: "public-fixture", serviceRoleKey: "service-fixture" }, { CRON_SECRET: "fixture-cron" }, {
    SystemRoot: "C:\\Windows", PATH: "safe-path", NODE_OPTIONS: "--require unsafe", SUPABASE_SERVICE_ROLE_KEY: "real-secret", RESEND_API_KEY: "real-key", NEXT_PUBLIC_TURN_URL: "turn:example.com", HTTP_PROXY: "http://external", NEXT_PUBLIC_COOKIE_DOMAIN: ".example.com", PB_EVENT_REMINDERS_ENABLED: "true",
  });
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "service-fixture"); assert.equal(env.PB_PUBLIC_ORIGIN, "http://127.0.0.1:3010");
  assert.equal(env.PB_EVENT_REMINDERS_ENABLED, "false"); assert.equal(env.PATH, "safe-path");
  for (const key of ["NODE_OPTIONS", "RESEND_API_KEY", "NEXT_PUBLIC_TURN_URL", "HTTP_PROXY", "NEXT_PUBLIC_COOKIE_DOMAIN"]) assert.equal(env[key], undefined);
});
test("copy includes regular assets but never environment, Git, private keys or aliases", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pb-auth-copy-test-"));
  try {
    const source = join(temp, "source"), target = join(temp, "target"); await mkdir(source);
    await writeFile(join(source, "page.tsx"), "synthetic component"); await writeFile(join(source, ".env.local"), "DO_NOT_COPY=synthetic"); await writeFile(join(source, "key.pem"), "synthetic");
    await mkdir(join(source, ".git")); await writeFile(join(source, ".git", "config"), "synthetic");
    await copySafeTree(source, target);
    assert.equal(await readFile(join(target, "page.tsx"), "utf8"), "synthetic component");
    for (const name of [".env.local", "key.pem", ".git"]) await assert.rejects(readFile(join(target, name)));
    const external = join(temp, "external"); await mkdir(external); await writeFile(join(external, "private.txt"), "synthetic");
    await symlink(external, join(source, "alias"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(copySafeTree(source, join(temp, "refused")), /aliases/);
    assert.equal(await readFile(join(external, "private.txt"), "utf8"), "synthetic");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test("font adaptation uses exact local cached bytes and rejects missing families", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pb-auth-font-test-"));
  try {
    const chunks = join(temp, "source", ".next", "static", "chunks"), media = join(temp, "source", ".next", "static", "media");
    await mkdir(chunks, { recursive: true }); await mkdir(media); const bytes = Buffer.from("fixture-font-content"); await writeFile(join(media, "font.woff2"), bytes);
    await writeFile(join(chunks, "fonts.css"), ["Geist", "Geist Mono", "Fraunces", "Noto Emoji"].map(name => `@font-face{font-family:"${name}";src:url(../media/font.woff2)format("woff2")}`).join(""));
    const runtime = join(temp, "runtime"); await mkdir(runtime);
    const mock = await prepareLocalFonts(join(temp, "source"), runtime);
    assert.deepEqual(await readFile(join(runtime, "fixture-fonts", "font.woff2")), bytes);
    const text = await readFile(mock, "utf8"); assert.match(text, /Geist Mono/); assert.doesNotMatch(text, /fonts\.googleapis/);
    const require = createRequire(import.meta.url), responses = require(mock);
    const { findFontFilesInCss } = require("next/dist/compiled/@next/font/dist/google/find-font-files-in-css.js");
    const files = findFontFilesInCss(responses["https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap"], []);
    assert.equal(files.length, 1); assert.deepEqual(await readFile(files[0].googleFontFileUrl), bytes);
    await writeFile(join(chunks, "fonts.css"), ""); const absent = join(temp, "absent"); await mkdir(absent);
    await assert.rejects(prepareLocalFonts(join(temp, "source"), absent), /four exact/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test("stop and cleanup affect only marked own runtime and preserve sibling contents", async () => {
  const temp = await realpath(tmpdir()), runtime = await mkdtemp(join(temp, "pb-local-auth-app-"));
  const sibling = await mkdtemp(join(temp, "pb-auth-preserve-")), file = join(runtime, "local-auth-app.json");
  try {
    await writeFile(join(sibling, "keep"), "synthetic original");
    await writeFile(file, JSON.stringify({ version: 1, kind: "photobooth-local-auth-app", runtime, owner: "a".repeat(32), origin: "http://127.0.0.1:3010" }));
    await requestLocalAppStop(file); assert.equal(await readFile(join(runtime, "stop.request"), "utf8"), "a".repeat(32));
    await assert.rejects(cleanupLocalApp(join(sibling, "local-auth-app.json")), /owned/);
    await cleanupLocalApp(file); await assert.rejects(readFile(file)); assert.equal(await readFile(join(sibling, "keep"), "utf8"), "synthetic original");
  } finally { await rm(runtime, { recursive: true, force: true }); await rm(sibling, { recursive: true, force: true }); }
});
test("owned tree stop rejects failure and timeout; successful stop awaits the child's exit", async () => {
  const child = { pid: 123, exitCode: null, signalCode: null };
  await assert.rejects(stopOwnedChild(child, new Promise(() => {}), { killTree: async () => 1, milliseconds: 20 }), /failed/);
  await assert.rejects(stopOwnedChild(child, new Promise(() => {}), { killTree: () => new Promise(() => {}), milliseconds: 20 }), /timed out/);
  let stopped;
  const exited = new Promise(resolveExit => { stopped = resolveExit; });
  await stopOwnedChild(child, exited, { killTree: async pid => { assert.equal(pid, 123); child.exitCode = 0; stopped({ code: 0 }); return 0; }, milliseconds: 20 });
  assert.equal(child.exitCode, 0);
});
test("private diagnostics redact known fixture credentials and URL/JWT credentials", () => {
  const text = redactLocalLog("local-service-secret https://127.0.0.1/file?token=opaque-value&x=1 eyJabc.def.ghi", ["local-service-secret"]);
  assert.doesNotMatch(text, /local-service-secret|opaque-value|eyJabc/); assert.match(text, /redacted/);
});
test("private diagnostics remove PKCE callback codes and authentication query or fragment tokens", () => {
  const text = redactLocalLog('GET /auth/callback?code=synthetic-pkce&next=%2Ftimeline 200\n"/auth/confirm?token_hash=synthetic-hash&type=email"\n/#access_token=synthetic-access&refresh_token=synthetic-refresh&expires_in=3600\n/?CODE=encoded%2Bsynthetic#safe', []);
  assert.doesNotMatch(text, /synthetic-pkce|synthetic-hash|synthetic-access|synthetic-refresh|encoded%2Bsynthetic/);
  assert.match(text, /\?code=\[redacted\]&next=%2Ftimeline 200/);
  assert.match(text, /token_hash=\[redacted\]&type=email"/);
  assert.match(text, /#access_token=\[redacted\]&refresh_token=\[redacted\]&expires_in=3600/);
  assert.match(text, /\?CODE=\[redacted\]#safe/);
});
