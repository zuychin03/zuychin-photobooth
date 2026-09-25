import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ORIGIN = "http://127.0.0.1:3010";
const METADATA = "local-auth-app.json";
const inside = (root, path) => { const r = relative(root, path); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const privateName = name => /^\.env(?:\.|$)/i.test(name) || /\.(?:pem|key|pfx|p12)$/i.test(name);
const omitted = new Set([".git", ".next", ".cache", ".bin", "docs", "coverage"]);
const sourceDirectories = ["app", "components", "hooks", "lib", "public", "types", "workers"];
const sourceFiles = ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "next-env.d.ts", "postcss.config.mjs", "proxy.ts"];

async function jsonFile(path, max = 32768) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error("Expected a bounded regular metadata file");
  return JSON.parse(await readFile(path, "utf8"));
}
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Unexpected metadata shape");
}
export async function readLocalConnection(file) {
  file = resolve(file);
  if (basename(file) !== "connection.json" || (await lstat(file)).isSymbolicLink()) throw new Error("Expected the fixture connection.json");
  const connection = await jsonFile(file);
  exact(connection, ["supabaseUrl", "anonKey", "serviceRoleKey", "projectId", "workdir"]);
  const temp = await realpath(tmpdir()), workdir = await realpath(dirname(file));
  if (!inside(temp, workdir) || dirname(workdir) !== temp || !/^pb-local-supabase-[a-f0-9]{10}$/.test(basename(workdir)) || resolve(connection.workdir) !== workdir || await realpath(file) !== join(workdir, "connection.json")) throw new Error("Connection is not inside its owned temporary fixture");
  const marker = await jsonFile(join(workdir, "local-supabase-owner.json"));
  exact(marker, ["version", "kind", "projectId", "workdir"]);
  if (marker.version !== 1 || marker.kind !== "photobooth-local-supabase" || marker.workdir !== workdir || marker.projectId !== connection.projectId || !/^[a-z][a-z0-9_-]{3,80}$/.test(connection.projectId)) throw new Error("Fixture ownership marker mismatch");
  const url = new URL(connection.supabaseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1024 || url.username || url.password || url.search || url.hash || url.pathname !== "/" || connection.supabaseUrl !== url.origin || url.port === "3010") throw new Error("Only an explicit loopback Supabase origin is accepted");
  for (const key of [connection.anonKey, connection.serviceRoleKey]) if (typeof key !== "string" || key.length < 20 || key.length > 8192 || /\s/.test(key)) throw new Error("Invalid local fixture credentials");
  if (connection.anonKey === connection.serviceRoleKey) throw new Error("Distinct local public and service credentials required");
  return connection;
}
export function localAppEnvironment(connection, secrets, inherited = process.env) {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "PATH", "Path", "COMSPEC"]) if (inherited[key]) env[key] = inherited[key];
  return { ...env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", BROWSER: "none",
    NEXT_PUBLIC_SUPABASE_URL: connection.supabaseUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: connection.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: connection.serviceRoleKey, PB_PUBLIC_ORIGIN: APP_ORIGIN,
    PB_CLOUD_PROJECTS_ENABLED: "true", PB_CHALLENGES_ENABLED: "true", PB_MEMORIES_ENABLED: "true",
    PB_VOICE_CAPTIONS_ENABLED: "true", PB_ROOM_V2_ENABLED: "true", PB_EVENTS_ENABLED: "true",
    PB_EVENT_REMINDERS_ENABLED: "false", ...secrets };
}
async function planSafeTree(source, destination, budget, planned) {
  if ((await lstat(source)).isSymbolicLink()) throw new Error("Source directory aliases are refused");
  const root = await realpath(source);
  async function visit(from, to) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (omitted.has(entry.name) || privateName(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error("Source and dependency aliases must be regular files for this rehearsal");
      const input = join(from, entry.name), output = join(to, entry.name);
      if (!inside(root, await realpath(input))) throw new Error("Copy escaped its source directory");
      if (entry.isDirectory()) await visit(input, output);
      else if (entry.isFile()) {
        const info = await lstat(input); budget.files++; budget.bytes += info.size;
        if (budget.files > 100000 || budget.bytes > 3 * 1024 ** 3 || info.size > 512 * 1024 ** 2) throw new Error("Local application copy exceeds its bounded budget");
        planned.push({ input, output });
      } else throw new Error("Non-regular source file refused");
    }
  }
  await visit(root, destination);
}
async function copyPlanned(planned) {
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(8, planned.length) }, async () => {
    while (!failure && next < planned.length) {
      const { input, output } = planned[next++];
      try {
        if ((await lstat(input)).isSymbolicLink()) throw new Error("Source changed during copy");
        await mkdir(dirname(output), { recursive: true }); await copyFile(input, output);
      } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
}
export async function copySafeTree(source, destination, budget = { files: 0, bytes: 0 }) {
  const planned = []; await planSafeTree(source, destination, budget, planned); await copyPlanned(planned); return budget;
}
export async function prepareLocalFonts(source, runtime) {
  const chunks = join(source, ".next", "static", "chunks"), media = await realpath(join(source, ".next", "static", "media"));
  const families = ["Geist", "Geist Mono", "Fraunces", "Noto Emoji"], css = Object.fromEntries(families.map(name => [name, []]));
  const output = join(runtime, "fixture-fonts"); await mkdir(output);
  let files = 0;
  for (const name of await readdir(chunks)) {
    if (!name.endsWith(".css")) continue;
    const path = join(chunks, name), info = await lstat(path);
    if (!info.isFile() || info.size > 4 * 1024 ** 2) throw new Error("Unsupported cached font stylesheet");
    for (const match of (await readFile(path, "utf8")).matchAll(/@font-face\{[^}]+\}/g)) {
      const family = /font-family:\s*["']?([^;"']+)/.exec(match[0])?.[1].trim();
      if (!families.includes(family) || !match[0].includes("url(")) continue;
      const asset = /url\(["']?(\.\.\/media\/[A-Za-z0-9_.-]+\.woff2)["']?\)/.exec(match[0]);
      if (!asset) throw new Error("Cached font must reference a local WOFF2 asset");
      const input = await realpath(join(chunks, asset[1])), fontInfo = await lstat(input);
      if (!inside(media, input) || !fontInfo.isFile() || fontInfo.size > 4 * 1024 ** 2 || ++files > 96) throw new Error("Cached font asset exceeds bounds");
      const target = join(output, basename(input)); await copyFile(input, target);
      // Next's existing font test hook reads slash-rooted files from the current drive on Windows.
      const loaderPath = target.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
      css[family].push(match[0].replace(asset[0], `url(${loaderPath})`).replace(/src:\s*url/, "src: url"));
    }
  }
  if (families.some(name => css[name].length === 0)) throw new Error("The existing production build must contain all four exact app fonts");
  const mock = join(runtime, "fixture-fonts.cjs");
  await writeFile(mock, `const css=${JSON.stringify(Object.fromEntries(families.map(name => [name, css[name].join("\n")])))};\nmodule.exports=new Proxy({}, {get(_target,url){if(typeof url!=="string")return undefined;const family=new URL(url).searchParams.get("family")?.split(":")[0];return css[family];}});\n`, { flag: "wx" });
  return mock;
}
async function ownedRuntime(metadataFile) {
  const runtime = await realpath(dirname(resolve(metadataFile))), temp = await realpath(tmpdir());
  if (basename(metadataFile) !== METADATA || dirname(runtime) !== temp || !/^pb-local-auth-app-[A-Za-z0-9]{6}$/.test(basename(runtime)) || !inside(temp, runtime)) throw new Error("Not an owned local auth application directory");
  const metadata = await jsonFile(join(runtime, METADATA));
  if (metadata.version !== 1 || metadata.kind !== "photobooth-local-auth-app" || metadata.runtime !== runtime || metadata.origin !== APP_ORIGIN || !/^[a-f0-9]{32}$/.test(metadata.owner)) throw new Error("Local app ownership marker mismatch");
  return { runtime, metadata };
}
export async function cleanupLocalApp(metadataFile) {
  const { runtime } = await ownedRuntime(metadataFile);
  await rm(runtime, { recursive: true, force: true });
}
export async function requestLocalAppStop(metadataFile) {
  const { runtime, metadata } = await ownedRuntime(metadataFile);
  await rm(join(runtime, "stop-error.json"), { force: true });
  await writeFile(join(runtime, "stop.request"), metadata.owner, { mode: 0o600 });
}
async function deadline(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export async function stopOwnedChild(child, exited, { killTree, milliseconds = 15000 } = {}) {
  if (!Number.isInteger(child.pid)) return;
  const live = () => child.exitCode === null && child.signalCode === null;
  if (live() && Number.isInteger(child.pid)) {
    const kill = killTree ?? (async pid => {
      if (process.platform !== "win32") { child.kill("SIGTERM"); return 0; }
      return await new Promise((resolveKill, reject) => {
        const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }, signal: AbortSignal.timeout(milliseconds) });
        killer.once("error", () => reject(new Error("Owned process tree stop failed"))); killer.once("exit", code => resolveKill(code));
      });
    });
    const code = await deadline(kill(child.pid), milliseconds, "Owned process stop timed out");
    if (code !== 0 && live()) throw new Error("Owned process tree stop failed; runtime retained");
  }
  await deadline(exited, milliseconds, "Owned process did not stop; runtime retained").catch(error => { if (live()) throw error; });
}
export function redactLocalLog(value, privateValues) {
  for (const secret of privateValues) if (secret) value = value.replaceAll(secret, "[redacted]");
  return value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-token]").replace(/([?&#](?:code|token_hash|access_token|refresh_token|token|apikey|key)=)[^\s&#"']+/gi, "$1[redacted]");
}
async function assertPortFree() {
  await new Promise((resolveFree, reject) => {
    const server = createServer(); server.once("error", () => reject(new Error("Port 3010 is occupied; no existing process was stopped")));
    server.listen(3010, "127.0.0.1", () => server.close(resolveFree));
  });
}
export async function launchLocalAuthApp({ connectionFile, source = resolve(dirname(fileURLToPath(import.meta.url)), ".."), onPrepared = () => {} }) {
  const connection = await readLocalConnection(connectionFile); source = await realpath(source);
  if ((await jsonFile(join(source, "package.json"))).name !== "zuychin-photobooth") throw new Error("Unexpected source repository");
  await assertPortFree();
  const temp = await realpath(tmpdir()), runtime = await mkdtemp(join(temp, "pb-local-auth-app-"));
  const metadataFile = join(runtime, METADATA), owner = randomBytes(16).toString("hex");
  const secrets = { CRON_SECRET: randomBytes(32).toString("hex"), PB_EVENT_TRANSPORT_SECRET: randomBytes(32).toString("hex"), PB_ROOM_RATE_SECRET: randomBytes(32).toString("hex") };
  const metadata = { version: 1, kind: "photobooth-local-auth-app", owner, runtime, source, projectId: connection.projectId, origin: APP_ORIGIN, fixtureWorkdir: connection.workdir, secrets };
  try { await writeFile(metadataFile, JSON.stringify(metadata, null, 2), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (await realpath(runtime) === runtime && dirname(runtime) === temp) await rm(runtime, { recursive: true, force: true }); throw error; }
  let child, stopTimer, logTimer, stopping = false, closing, close, log = "", logWrite = Promise.resolve(), logWriting = false, logCapped = false;
  const flushLog = () => {
    if (logWriting) return logWrite;
    const complete = log.slice(0, log.lastIndexOf("\n") + 1);
    const safe = redactLocalLog(complete, [connection.anonKey, connection.serviceRoleKey, ...Object.values(secrets)]);
    logWriting = true;
    logWrite = writeFile(join(runtime, "app-private.log"), safe, { mode: 0o600 }).finally(() => { logWriting = false; });
    return logWrite;
  };
  try {
    const app = join(runtime, "app"); await mkdir(app);
    const budget = { files: 0, bytes: 0 }, planned = [];
    for (const name of [...sourceDirectories, "node_modules"]) await planSafeTree(join(source, name), join(app, name), budget, planned);
    for (const name of sourceFiles) { const input = join(source, name), info = await lstat(input); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Root source config must be a regular file"); budget.bytes += info.size; planned.push({ input, output: join(app, name) }); }
    const space = await statfs(runtime);
    if (space.bavail * space.bsize < budget.bytes + 512 * 1024 ** 2) throw new Error("Insufficient temporary disk capacity for an isolated copy");
    await copyPlanned(planned);
    const fontMock = await prepareLocalFonts(source, runtime), env = localAppEnvironment(connection, secrets);
    env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = fontMock;
    child = spawn(process.execPath, [join(app, "node_modules", "next", "dist", "bin", "next"), "dev", app, "--webpack", "--hostname", "127.0.0.1", "--port", "3010"], { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = chunk => {
      if (logCapped) return;
      const bytes = Buffer.from(log + chunk.toString("utf8")); log = bytes.subarray(0, 65536).toString("utf8");
      if (bytes.length > 65536) { logCapped = true; log = log.slice(0, log.lastIndexOf("\n") + 1); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    logTimer = setInterval(() => { void flushLog().catch(() => {}); }, 1000);
    const exited = new Promise((resolveExit, reject) => { child.once("error", () => reject(new Error("Isolated app process failed to start"))); child.once("exit", (code, signal) => resolveExit({ code, signal })); });
    close = () => closing ??= (async () => {
      stopping = true;
      await stopOwnedChild(child, exited);
      await assertPortFree();
      clearInterval(stopTimer); clearInterval(logTimer); await logWrite.catch(() => {});
      await cleanupLocalApp(metadataFile);
    })().catch(async error => {
      stopping = false; closing = undefined;
      await rm(join(runtime, "stop.request"), { force: true }).catch(() => {});
      await writeFile(join(runtime, "stop-error.json"), JSON.stringify({ error: "Owned app stop failed; private runtime retained for retry" }), { mode: 0o600 }).catch(() => {});
      throw error;
    });
    stopTimer = setInterval(() => { void readFile(join(runtime, "stop.request"), "utf8").then(value => { if (value === owner) void close().catch(() => {}); }, () => {}); }, 500);
    // Unexpected exits retain bounded diagnostics until explicit cleanup, in case a descendant is still alive.
    const done = exited.then(async result => { clearInterval(logTimer); await flushLog().catch(() => {}); return { ...result, expected: stopping }; }, async error => { clearInterval(logTimer); await flushLog().catch(() => {}); throw error; });
    onPrepared({ metadataFile, origin: APP_ORIGIN });
    return { metadataFile, origin: APP_ORIGIN, close, done };
  } catch (error) {
    clearInterval(stopTimer); clearInterval(logTimer);
    if (close) await close(); else if (!child) await cleanupLocalApp(metadataFile);
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write("Usage: node scripts/local-auth-app.mjs --connection-file <owned-temp/connection.json>\nStop: node scripts/local-auth-app.mjs --stop <printed-metadata-path>\nStarts only 127.0.0.1:3010; copies source/dependencies; no inherited provider credentials.\n"); return;
  }
  if (args.length !== 2 || !["--connection-file", "--stop"].includes(args[0])) throw new Error("Use --help for the explicit local commands");
  if (args[0] === "--stop") {
    await requestLocalAppStop(args[1]);
    const until = Date.now() + 35000;
    while (Date.now() < until) {
      try { await lstat(args[1]); } catch (error) { if (error.code === "ENOENT") { process.stdout.write("Owned local app stopped and its runtime removed.\n"); return; } throw error; }
      const errorFile = await readFile(join(dirname(resolve(args[1])), "stop-error.json"), "utf8").catch(() => null);
      if (errorFile) throw new Error("Stop failed; runtime retained");
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
    }
    throw new Error("Stop was not acknowledged; runtime retained");
  }
  let app, interrupted = false;
  const stop = () => { interrupted = true; if (app) void app.close().catch(() => { process.stderr.write("Owned app stop failed; retry --stop using its metadata path.\n"); }); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    app = await launchLocalAuthApp({ connectionFile: args[1], onPrepared: ({ metadataFile, origin }) => process.stdout.write(JSON.stringify({ metadataFile, origin }) + "\n") });
    if (interrupted) await app.close();
    const result = await app.done; if (!result.expected) throw new Error("Isolated development app exited unexpectedly");
    await app.close();
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { process.stderr.write("Local auth app operation failed. Check fixture ownership, available port, cached fonts and source dependencies. No credential values were logged.\n"); process.exitCode = 1; });
