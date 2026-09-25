import assert from "node:assert/strict";
import test from "node:test";
import { authorizeCron, canonicalPublicOrigin } from "../lib/server/cron-auth";

const env = { CRON_SECRET: "fixture-cron-key", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key" };
const request = (auth?: string, query = "") => new Request(`https://app.example.test/api/reminders${query}`, { headers: auth ? { authorization: auth } : {} });

test("cron boundary fails closed for every missing credential", () => {
  for (const key of Object.keys(env)) {
    const result = authorizeCron(request("Bearer fixture-cron-key"), { ...env, [key]: undefined });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 503);
      assert.equal(result.response.headers.get("cache-control"), "private, no-store");
    }
  }
});

test("cron boundary accepts only the configured bearer and rejects query secrets", () => {
  for (const auth of [undefined, "Basic fixture-cron-key", "Bearer wrong", "Bearer fixture-cron-key extra"]) {
    assert.equal(authorizeCron(request(auth), env).ok, false);
  }
  assert.equal(authorizeCron(request(undefined, "?secret=fixture-cron-key"), env).ok, false);
  assert.equal(authorizeCron(request("Bearer fixture-cron-key", "?secret=fixture-cron-key"), env).ok, false);
  assert.equal(authorizeCron(request("Bearer fixture-cron-key"), env).ok, true);
});

test("configuration rejects unsafe service URLs and requires a canonical HTTPS public origin", () => {
  for (const value of ["", "not-a-url", "http://remote.example.test", "https://user:pass@db.example.test", "https://db.example.test/path", "https://db.example.test/?secret=x"]) {
    assert.equal(authorizeCron(request("Bearer fixture-cron-key"), { ...env, NEXT_PUBLIC_SUPABASE_URL: value }).ok, false);
    assert.equal(canonicalPublicOrigin(value), null);
  }
  assert.equal(canonicalPublicOrigin("https://booth.example.test/"), "https://booth.example.test");
  assert.equal(canonicalPublicOrigin("http://localhost:3000"), null);
  assert.equal(authorizeCron(request("Bearer fixture-cron-key"), { ...env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }).ok, true);
});
