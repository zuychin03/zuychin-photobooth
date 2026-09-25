import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MANIFEST = "fallback-manifest.json";
const omitted = new Set([".git", ".bin", ".cache", "coverage"]);
const safePath = value => typeof value === "string" && value.length > 0 && !isAbsolute(value) && !value.includes("\\") && value.split("/").every(p => p && p !== "." && p !== ".." && !p.includes(":"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const privateName = name => /^\.env(?:\.|$)/i.test(name) || /\.(?:pem|key|pfx|p12)$/i.test(name);
const inside = (root, file) => { const rel = relative(root, file); return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel); };
export async function boundedFiles(files, work) {
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (!failure && next < files.length) { const file = files[next++]; try { await work(file); } catch (error) { failure ??= error; } }
  }));
  if (failure) throw failure;
}
async function digestFile(path, secrets = []) {
  const digest = createHash("sha256"); let size = 0, tail = Buffer.alloc(0);
  const overlap = Math.max(0, ...secrets.map(v => v.length - 1));
  for await (const chunk of createReadStream(path)) {
    const check = Buffer.concat([tail, chunk]);
    if (secrets.some(secret => check.includes(secret))) throw new Error("Private environment material detected; artifact refused");
    tail = overlap ? check.subarray(Math.max(0, check.length - overlap)) : Buffer.alloc(0); digest.update(chunk); size += chunk.length;
  }
  return { bytes: size, sha256: digest.digest("hex") };
}
async function inventory(root, sub = "", skip = () => false, dependencyRoot = null, links = new Set()) {
  const result = [];
  for (const entry of await readdir(join(root, sub), { withFileTypes: true })) {
    const path = sub ? `${sub}/${entry.name}` : entry.name;
    if (skip(path, entry.name)) continue;
    if (entry.isSymbolicLink()) {
      const target = await realpath(join(root, path));
      if (!dependencyRoot || !inside(dependencyRoot, target) || links.has(target) || links.size >= 16 || relative(dependencyRoot, target).split(sep).some(privateName)) throw new Error(`Symbolic link refused: ${path}`);
      const info = await lstat(target);
      if (info.isDirectory()) result.push(...await inventory(root, path, skip, dependencyRoot, new Set([...links, target])));
      else if (info.isFile()) result.push(path);
      else throw new Error(`Non-regular dependency alias refused: ${path}`);
      continue;
    }
    if (entry.isDirectory()) result.push(...await inventory(root, path, skip, dependencyRoot, links));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Non-regular artifact file refused: ${path}`);
  }
  return result.sort();
}
export async function privateEnvironmentValues(root, env = process.env) {
  const values = [];
  const accept = (name, value) => { if (!name.startsWith("NEXT_PUBLIC_") && /SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE|API_KEY/i.test(name) && typeof value === "string" && value.trim().length >= 8) values.push(Buffer.from(value.trim())); };
  for (const [key, value] of Object.entries(env)) accept(key, value);
  for (const name of await readdir(root)) {
    if (!/^\.env(?:\.|$)/i.test(name) || name === ".env.example") continue;
    const path = join(root, name); if (!(await lstat(path)).isFile()) throw new Error("Non-regular environment file refused");
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!match) continue;
      let value = match[2]; const quote = value[0];
      if (["'", '"', "`"].includes(quote)) { const end = value.indexOf(quote, 1); if (end < 0) throw new Error("Multiline environment material requires a separate clean build before snapshot"); value = value.slice(1, end); if (quote === '"') value = value.replaceAll("\\n", "\n").replaceAll("\\r", "\r"); }
      else value = value.split("#", 1)[0].trim();
      if (!match[1].startsWith("NEXT_PUBLIC_") && /SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE|API_KEY/i.test(match[1]) && value.includes("${")) throw new Error("Expanded private environment material requires a separate clean build before snapshot");
      accept(match[1], value);
    }
  }
  return values;
}
export async function freezeFallback({ source = process.cwd(), destination, nodeExecutable = process.execPath, env = process.env }) {
  source = await realpath(source);
  if (!destination) throw new Error("A new explicit destination is required");
  destination = join(await realpath(dirname(resolve(destination))), resolve(destination).split(sep).at(-1));
  if (destination === source || inside(source, destination) || inside(destination, source)) throw new Error("Artifact must be outside the source tree");
  const buildId = (await readFile(join(source, ".next/BUILD_ID"), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(buildId)) throw new Error("A completed production build is required");
  const secrets = await privateEnvironmentValues(source, env), paths = [];
  for (const directory of [".next", "public", "node_modules"]) {
    if (!(await lstat(join(source, directory))).isDirectory()) throw new Error(`Missing ${directory}`);
    paths.push(...(await inventory(join(source, directory), "", (path, name) => omitted.has(name) || privateName(name) || directory === ".next" && /^(?:dev|cache|diagnostics|types|trace|trace-build|turbopack)(?:\/|$)/.test(path), directory === ".next" ? await realpath(join(source, "node_modules")) : null)).map(path => `${directory}/${path}`));
  }
  for (const name of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "next-env.d.ts"]) { if ((await lstat(join(source, name))).isSymbolicLink()) throw new Error("Root file symlink refused"); paths.push(name); }
  await mkdir(destination); // Never overwrite an existing artifact.
  const created = await realpath(destination); if (created !== destination || inside(source, created)) throw new Error("Artifact destination changed during creation");
  const files = [];
  for (const path of paths.sort()) {
    const output = join(destination, path); await mkdir(dirname(output), { recursive: true }); await copyFile(join(source, path), output);
    files.push({ path, ...await digestFile(output, secrets) });
  }
  const nodePath = process.platform === "win32" ? "runtime/node.exe" : "runtime/node";
  await mkdir(join(destination, "runtime")); await copyFile(nodeExecutable, join(destination, nodePath)); await chmod(join(destination, nodePath), 0o755);
  files.push({ path: nodePath, ...await digestFile(join(destination, nodePath), secrets) }); files.sort((a, b) => a.path.localeCompare(b.path));
  if ((await readFile(join(source, ".next/BUILD_ID"), "utf8")).trim() !== buildId) throw new Error("Build changed during snapshot; artifact is incomplete");
  const payload = { version: 1, buildId, platform: process.platform, arch: process.arch, nodeVersion: process.version, nodePath, files };
  const manifest = { ...payload, integrity: hash(JSON.stringify(payload)) };
  await writeFile(join(destination, MANIFEST), JSON.stringify(manifest, null, 2), { flag: "wx" });
  return { destination, buildId, integrity: manifest.integrity, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
export async function verifyFallback(directory) {
  directory = await realpath(directory);
  const m = JSON.parse(await readFile(join(directory, MANIFEST), "utf8")), { integrity, ...payload } = m;
  if (m.version !== 1 || m.platform !== process.platform || m.arch !== process.arch || !Array.isArray(m.files) || m.files.length > 150000 || !safePath(m.nodePath) || hash(JSON.stringify(payload)) !== integrity) throw new Error("Invalid fallback manifest");
  const paths = m.files.map(file => file.path);
  if (paths.some(path => !safePath(path) || path.split("/").some(part => privateName(part) || part === ".git")) || new Set(paths).size !== paths.length || !paths.includes(m.nodePath)) throw new Error("Invalid fallback inventory");
  const actual = (await inventory(directory)).filter(path => path !== MANIFEST);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...paths].sort())) throw new Error("Fallback inventory changed");
  await boundedFiles(m.files, async file => { const checked = await digestFile(join(directory, file.path)); if (checked.bytes !== file.bytes || checked.sha256 !== file.sha256) throw new Error(`Fallback checksum mismatch: ${file.path}`); });
  return m;
}
export function fallbackEnvironment(env = process.env) {
  const result = { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "PATH", "Path", "HOME", "USERPROFILE", "COMSPEC"]) if (env[key]) result[key] = env[key];
  for (const key of ["PB_EVENTS_ENABLED", "PB_CLOUD_PROJECTS_ENABLED", "PB_ROOM_V2_ENABLED", "PB_MEMORIES_ENABLED"]) result[key] = "false";
  return result;
}
async function removeRuntime(runtime) {
  const target = await realpath(runtime); if (!inside(await realpath(tmpdir()), target) || !target.split(sep).at(-1).startsWith("pb-local-fallback-")) throw new Error("Runtime cleanup boundary refused");
  await rm(target, { recursive: true, force: true });
}
export async function materialiseFallback(directory, m) {
  const { integrity, ...payload } = m;
  if (hash(JSON.stringify(payload)) !== integrity || !Array.isArray(m.files) || m.files.some(file => !safePath(file.path)) || !safePath(m.nodePath)) throw new Error("Invalid runtime inventory");
  const runtime = await mkdtemp(join(tmpdir(), "pb-local-fallback-"));
  try {
    await boundedFiles(m.files, async file => { const target = join(runtime, file.path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(directory, file.path), target); });
    await writeFile(join(runtime, MANIFEST), JSON.stringify(m)); await verifyFallback(runtime); await chmod(join(runtime, m.nodePath), 0o755); return runtime;
  } catch (error) { await removeRuntime(runtime); throw error; }
}
export async function launchFallback(directory, port = 3016) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid loopback port");
  const m = await verifyFallback(directory), runtime = await materialiseFallback(directory, m);
  let child;
  try { child = spawn(join(runtime, m.nodePath), ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: runtime, env: fallbackEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { await removeRuntime(runtime); throw error; }
  let output = ""; const capture = data => { output = (output + data.toString()).slice(-4096); }; child.stdout.on("data", capture); child.stderr.on("data", capture);
  const exited = new Promise(resolveExit => { child.once("error", () => resolveExit(1)); child.once("exit", code => resolveExit(code ?? 1)); });
  let closed, expected = false;
  const done = exited.then(async code => { await removeRuntime(runtime); return { code, expected }; });
  return { port, buildId: m.buildId, integrity: m.integrity, done, get output() { return output; }, close() { return closed ??= (async () => { expected = true; child.kill(); await done; })(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, destination, extra] = process.argv.slice(2);
  if (action === "freeze" && destination && !extra) console.log(JSON.stringify(await freezeFallback({ destination })));
  else if (action === "verify" && destination && !extra) { const m = await verifyFallback(destination); console.log(JSON.stringify({ buildId: m.buildId, integrity: m.integrity, files: m.files.length })); }
  else if (action === "run" && destination && (!extra || /^\d+$/.test(extra))) { const run = await launchFallback(destination, extra ? Number(extra) : 3016); console.log(`Verified local fallback starting on loopback port ${run.port}; artifact ${run.integrity}. Browser access must use the network-restricting rehearsal proxy; compiled public configuration may remain.`); for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void run.close().then(() => process.exit(0)); }); const end = await run.done; if (!end.expected) { console.error("Fallback process exited unexpectedly; its disposable runtime was cleaned."); process.exitCode = end.code || 1; } }
  else throw new Error("Usage: local-fallback-artifact.mjs freeze NEW_OUTSIDE_DIRECTORY | verify DIRECTORY | run DIRECTORY [PORT]. Freeze only after the final build checkpoint. No env files are copied; incomplete snapshots have no manifest. Same-platform local evidence only.");
}
