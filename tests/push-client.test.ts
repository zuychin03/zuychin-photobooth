import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Row = { owner: string; endpoint: string; p256dh: string; auth: string };
type Client = { getPushState(owner: string): Promise<string>; enablePush(owner: string): Promise<string>; disablePush(owner: string): Promise<string> };
function fixture(endpoint = "https://fcm.googleapis.com/synthetic") {
  const state = { owner: "owner-a", row: null as Row | null, upserts: 0, deletes: 0, unsubscribes: 0, subscribed: true, saveFails: false, readFails: false, deleteFails: false, unsubscribeFails: false, onRead: () => {}, onSave: () => {} };
  const keys = { p256dh: "synthetic-public", auth: "synthetic-auth" };
  const subscription = { endpoint, toJSON: () => ({ endpoint, keys }), unsubscribe: async () => { state.unsubscribes++; if (state.unsubscribeFails) throw new Error("private provider details"); state.subscribed = false; return true; } };
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: state.owner } }, error: null }) },
    from: () => ({
      upsert: async (row: Row) => { state.upserts++; state.onSave(); if (state.saveFails) return { error: new Error("private database details") }; state.row = { ...row }; return { error: null }; },
      select: () => {
        const filters: Record<string, string> = {};
        const query = { eq: (key: string, value: string) => { filters[key] = value; return query; }, maybeSingle: async () => { state.onRead(); return { data: state.row && Object.entries(filters).every(([key, value]) => state.row![key as keyof Row] === value) ? state.row : null, error: state.readFails ? new Error("private database details") : null }; } };
        return query;
      },
      delete: () => {
        const filters: Record<string, string> = {};
        const query = { eq: (key: string, value: string) => { filters[key] = value; return query; }, then: (resolve: (value: unknown) => unknown) => { state.deletes++; if (!state.deleteFails && state.row && Object.entries(filters).every(([key, value]) => state.row![key as keyof Row] === value)) state.row = null; return Promise.resolve(resolve({ error: state.deleteFails ? new Error("private database details") : null })); } };
        return query;
      },
    }),
  };
  const registration = { pushManager: { getSubscription: async () => state.subscribed ? subscription : null, subscribe: async () => { state.subscribed = true; return subscription; } } };
  const browser = { serviceWorker: { getRegistration: async () => registration, ready: Promise.resolve(registration) } };
  const notification = { permission: "granted", requestPermission: async () => "granted" };
  const load = (path: string): Record<string, unknown> => {
    const loadedModule = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", "window", "navigator", "Notification", "process", code)(
      (name: string) => name === "./supabase/client" ? { createClient: () => supabase } : name === "./push-endpoint" ? load("../lib/push-endpoint.ts") : assert.fail(`Unexpected module ${name}`), loadedModule, loadedModule.exports,
      { PushManager: {}, Notification: notification, atob: (value: string) => Buffer.from(value, "base64").toString("binary") }, browser, notification,
      { env: { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "c3ludGhldGlj", NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic" } },
    );
    return loadedModule.exports;
  };
  return { state, keys, endpoint, client: load("../lib/push-client.ts") as unknown as Client, load };
}

test("unsupported subscriptions never reach registration and remain available for explicit disable", async () => {
  const f = fixture("https://jmt17.google.com/synthetic");
  await assert.rejects(f.client.enablePush("owner-a"), error => error instanceof Error && "code" in error && error.code === "unsupported_endpoint");
  assert.equal(f.state.upserts, 0); assert.equal(f.state.unsubscribes, 0);
  assert.equal(await f.client.getPushState("owner-a"), "unsupported_subscription");
  assert.equal(await f.client.disablePush("owner-a"), "unsubscribed");
  assert.equal(f.state.unsubscribes, 1);
});

test("a failed save and a reload cannot label a browser-only subscription registered", async () => {
  const f = fixture(); f.state.saveFails = true;
  await assert.rejects(f.client.enablePush("owner-a"), error => error instanceof Error && !error.message.includes("private"));
  assert.equal(await f.client.getPushState("owner-a"), "unregistered");
  f.state.saveFails = false;
  assert.equal(await f.client.enablePush("owner-a"), "subscribed");
  assert.equal(await f.client.getPushState("owner-a"), "subscribed");
});

test("saved registration must match the current owner and browser keys", async () => {
  const f = fixture();
  f.state.row = { owner: "owner-b", endpoint: f.endpoint, ...f.keys };
  assert.equal(await f.client.getPushState("owner-a"), "unregistered");
  f.state.row.owner = "owner-a"; f.state.row.auth = "stale-key";
  assert.equal(await f.client.getPushState("owner-a"), "unregistered");
  f.state.row.auth = f.keys.auth;
  assert.equal(await f.client.getPushState("owner-a"), "subscribed");
  f.state.readFails = true;
  await assert.rejects(f.client.getPushState("owner-a"));
});

test("account changes cannot register or report another account's saved subscription", async () => {
  const f = fixture(); f.state.owner = "owner-b";
  await assert.rejects(f.client.enablePush("owner-a")); assert.equal(f.state.upserts, 0);
  f.state.owner = "owner-a"; f.state.row = { owner: "owner-a", endpoint: f.endpoint, ...f.keys };
  f.state.onRead = () => { f.state.owner = "owner-b"; };
  await assert.rejects(f.client.getPushState("owner-a"));
});

test("failed database removal preserves the browser subscription for an explicit retry", async () => {
  const f = fixture(); f.state.row = { owner: "owner-a", endpoint: f.endpoint, ...f.keys }; f.state.deleteFails = true;
  await assert.rejects(f.client.disablePush("owner-a"));
  assert.equal(f.state.unsubscribes, 0); assert(f.state.row);
  f.state.deleteFails = false;
  assert.equal(await f.client.disablePush("owner-a"), "unsubscribed"); assert.equal(f.state.row, null);
});

test("failed browser unsubscribe is visible and never claims the saved row still exists", async () => {
  const f = fixture(); f.state.row = { owner: "owner-a", endpoint: f.endpoint, ...f.keys }; f.state.unsubscribeFails = true;
  await assert.rejects(f.client.disablePush("owner-a"));
  assert.equal(f.state.row, null); assert.equal(await f.client.getPushState("owner-a"), "unregistered");
  f.state.unsubscribeFails = false;
  assert.equal(await f.client.disablePush("owner-a"), "unsubscribed");
});

test("the shared endpoint predicate retains the exact production host restrictions", () => {
  const valid = fixture().load("../lib/push-endpoint.ts").validPushEndpoint as (value: string) => boolean;
  for (const url of ["https://fcm.googleapis.com/a", "https://android.googleapis.com/a", "https://web.push.apple.com/a", "https://updates.push.services.mozilla.com/a", "https://wns.notify.windows.com/a"]) assert.equal(valid(url), true);
  for (const url of ["https://jmt17.google.com/a", "http://fcm.googleapis.com/a", "https://127.0.0.1/a", "https://fcm.googleapis.com.evil.invalid/a", "https://user@fcm.googleapis.com/a", "https://fcm.googleapis.com:8443/a", "https://fcm.googleapis.com/a#fragment", "https://fcm.googleapis.com/" + "a".repeat(4096)]) assert.equal(valid(url), false);
});
