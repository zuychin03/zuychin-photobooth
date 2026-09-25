import test from "node:test";
import assert from "node:assert/strict";
import { authCallbackOrigin } from "../lib/auth-callback-origin";
import { requireSameOrigin } from "../lib/server/request-security";

test("local callback retains the browser cookie host despite Next reconstructed localhost", () => {
  const request = new Request("http://localhost:3010/auth/callback?code=synthetic", { headers: { host: "127.0.0.1:3010" } });
  assert.equal(authCallbackOrigin(request, { NODE_ENV: "development" }), "http://127.0.0.1:3010");
  assert.equal(authCallbackOrigin(request, { NODE_ENV: "development", PB_PUBLIC_ORIGIN: "http://127.0.0.1:3010" }), "http://127.0.0.1:3010");
});

test("local API accepts exact browser Origin and Host while production remains canonical HTTPS only", () => {
  const request = (host: string, origin: string) => new Request("http://localhost:3010/api/projects", { headers: { host, origin } });
  const env = { NODE_ENV: "development", PB_PUBLIC_ORIGIN: "http://127.0.0.1:3010" };
  assert.doesNotThrow(() => requireSameOrigin(request("127.0.0.1:3010", "http://127.0.0.1:3010"), env));
  assert.doesNotThrow(() => requireSameOrigin(request("localhost:3010", "http://localhost:3010"), env));
  assert.equal(authCallbackOrigin(request("localhost:3010", "http://localhost:3010"), env), "http://localhost:3010");
  assert.throws(() => requireSameOrigin(request("localhost:3010", "http://127.0.0.1:3010"), env));
  assert.throws(() => requireSameOrigin(request("127.0.0.1:3010", "http://localhost:3010"), env));
  assert.throws(() => requireSameOrigin(request("127.0.0.1:3010", "http://127.0.0.1:3010"), { ...env, NODE_ENV: "production" }));
  assert.doesNotThrow(() => requireSameOrigin(new Request("https://internal.example/api/projects", { headers: { origin: "https://booth.example" } }), { NODE_ENV: "production", PB_PUBLIC_ORIGIN: "https://booth.example" }));
  assert.throws(() => requireSameOrigin(request("localhost:3010", "http://localhost:3010"), { ...env, PB_PUBLIC_ORIGIN: "http://127.0.0.1:3011" }));
  assert.equal(authCallbackOrigin(request("localhost:3010", "http://localhost:3010"), { ...env, PB_PUBLIC_ORIGIN: "https://booth.example" }), "https://booth.example");
});

test("canonical production origin wins and forwarded headers never choose a destination", () => {
  const request = new Request("https://internal.example/auth/callback", { headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } });
  assert.equal(authCallbackOrigin(request, { NODE_ENV: "production", PB_PUBLIC_ORIGIN: "https://booth.example" }), "https://booth.example");
  assert.equal(authCallbackOrigin(request, { NODE_ENV: "production" }), "https://internal.example");
});

test("local Host override rejects external hosts, user-info, paths and changed ports", () => {
  for (const host of ["evil.example:3010", "127.0.0.1:3011", "evil@127.0.0.1:3010", "127.0.0.1:3010/path", "127.0.0.1:3010#evil"]) {
    const request = new Request("http://localhost:3010/auth/callback", { headers: { host, "x-forwarded-host": "127.0.0.1:3010" } });
    assert.equal(authCallbackOrigin(request, { NODE_ENV: "development" }), "http://localhost:3010");
  }
  for (const origin of ["http://evil.example", "https://booth.example/path", "https://user@booth.example", "https://booth.example/"]) {
    assert.throws(() => authCallbackOrigin(new Request("https://booth.example"), { NODE_ENV: "production", PB_PUBLIC_ORIGIN: origin }));
  }
});
