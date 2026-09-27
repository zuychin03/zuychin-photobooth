import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { createScheduler, type SchedulerEnvironment } from "../workers/maintenance-scheduler/index";

const enabled: SchedulerEnvironment = {
  SCHEDULER_ENABLED: "true", EVENTS_ENABLED: "true", PROJECTS_ENABLED: "true",
  MEDIA_ENABLED: "true", REMINDERS_ENABLED: "true", CRON_SECRET: "synthetic-test-secret",
};
const minute = { cron: "* * * * *" }, quarter = { cron: "*/15 * * * *" };

test("deployment has no public endpoint or active cron by default", async () => {
  const config = JSON.parse((await readFile(new URL("../workers/maintenance-scheduler/wrangler.jsonc", import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []); assert.deepEqual(config.triggers.crons, []);
  assert.ok(Object.values(config.vars).every(value => value === "false"));
  assert.equal("fetch" in worker, false);
});

test("disabled or unknown schedules never fetch, even with a secret", async () => {
  let calls = 0;
  const handler = createScheduler({ fetch: async () => { calls++; return new Response(); }, log: () => {} });
  await handler.scheduled(minute, {});
  await handler.scheduled(minute, { ...enabled, SCHEDULER_ENABLED: "TRUE" });
  await handler.scheduled({ cron: "0 * * * *" }, enabled);
  await handler.scheduled(minute, { ...enabled, EVENTS_ENABLED: "false", PROJECTS_ENABLED: "false" });
  assert.equal(calls, 0);
});

test("active jobs fail closed on absent, blank or malformed secrets", async () => {
  let calls = 0;
  const handler = createScheduler({ fetch: async () => { calls++; return new Response(); }, log: () => {} });
  for (const secret of [undefined, "", " ", "bad\r\nsecret"]) {
    await assert.rejects(handler.scheduled(minute, { ...enabled, CRON_SECRET: secret }), /configuration unavailable/);
  }
  assert.equal(calls, 0);
});

test("minute calls only fixed project/event URLs with header auth and redirects refused", async () => {
  const calls: { url: string; init?: RequestInit }[] = [], deadlines: number[] = [];
  const handler = createScheduler({ fetch: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 200 }); }, log: () => {}, timeoutSignal: ms => { deadlines.push(ms); return new AbortController().signal; } });
  await handler.scheduled(minute, enabled);
  assert.deepEqual(calls.map(call => call.url).sort(), ["https://photobooth.zuychin.me/api/events/maintenance", "https://photobooth.zuychin.me/api/projects/maintenance"]);
  for (const call of calls) {
    assert.equal(call.init?.method, "GET"); assert.equal(call.init?.redirect, "error");
    assert.equal(new Headers(call.init?.headers).get("authorization"), "Bearer synthetic-test-secret");
    assert.ok(call.init?.signal); assert.equal(call.init?.body, undefined);
  }
  assert.deepEqual(deadlines, [120000, 120000]);
});

test("quarter-hour legacy-only pass avoids retention alias and V2 jobs", async () => {
  const calls: string[] = [];
  const handler = createScheduler({ fetch: async url => { calls.push(url); return new Response(); }, log: () => {} });
  await handler.scheduled(quarter, { ...enabled, EVENTS_ENABLED: "false", PROJECTS_ENABLED: "false" });
  assert.deepEqual(calls, ["https://photobooth.zuychin.me/api/media/maintenance", "https://photobooth.zuychin.me/api/reminders"]);
});

test("handler waits for every job even when an earlier job fails", async () => {
  let finish!: (response: Response) => void, settled = false;
  const handler = createScheduler({ fetch: async url => url.includes("events") ? new Response(null, { status: 503 }) : new Promise(resolve => { finish = resolve; }), log: () => {} });
  const result = handler.scheduled(minute, enabled).finally(() => { settled = true; });
  const failure = assert.rejects(result, /Maintenance pass failed/);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false);
  finish(new Response()); await failure; assert.equal(settled, true);
});

test("202, redirects, collisions and provider exceptions never become successful passes or leak details", async () => {
  const logs: string[] = [];
  for (const status of [202, 302, 409, 500]) {
    const handler = createScheduler({ fetch: async () => new Response("private-response-body", { status }), log: line => logs.push(line) });
    await assert.rejects(handler.scheduled(minute, enabled), /Maintenance pass failed/);
  }
  const handler = createScheduler({ fetch: async () => { throw new Error("synthetic-test-secret private-provider-error"); }, log: line => logs.push(line) });
  await assert.rejects(handler.scheduled(minute, enabled), /Maintenance pass failed/);
  assert.equal(logs.length, 10);
  assert.ok(logs.every(line => line.length < 150 && !/private-|synthetic-test-secret/.test(line)));
});

test("deadline abort settles the handler even if a transport ignores abort; late body is cancelled", async () => {
  const controller = new AbortController(); let complete!: (response: Response) => void, cancelled = false;
  const handler = createScheduler({ fetch: async () => new Promise(resolve => { complete = resolve; }), log: () => {}, timeoutSignal: () => controller.signal });
  const pending = handler.scheduled(minute, { ...enabled, PROJECTS_ENABLED: "false" });
  controller.abort(); await assert.rejects(pending, /Maintenance pass failed/);
  complete(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(cancelled, true);
});

test("successful response body is cancelled without reading it", async () => {
  let cancelled = false;
  const handler = createScheduler({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), log: () => {} });
  await handler.scheduled(minute, { ...enabled, PROJECTS_ENABLED: "false" });
  assert.equal(cancelled, true);
});

test("overlapping scheduled invocations dispatch independently and only report HTTP acknowledgement", async () => {
  const waiting: ((response: Response) => void)[] = [], logs: string[] = [];
  const handler = createScheduler({ fetch: async () => new Promise(resolve => { waiting.push(resolve); }), log: line => logs.push(line) });
  const first = handler.scheduled(minute, enabled), second = handler.scheduled(minute, enabled);
  assert.equal(waiting.length, 4);
  for (const resolve of waiting) resolve(new Response());
  await Promise.all([first, second]);
  assert.equal(logs.length, 4);
  assert.ok(logs.every(line => JSON.parse(line).outcome === "http_ok"));
});
