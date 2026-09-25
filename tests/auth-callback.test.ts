import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/auth/callback/route";

test("unconfigured callbacks return safely with the internal destination and no credentials", async () => {
  const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    const request = new URL("https://booth.example/auth/callback");
    request.searchParams.set("code", "synthetic-private-code");
    request.searchParams.set("token_hash", "synthetic-private-hash");
    request.searchParams.set("next", "/challenges/example?view=partial#review");
    const response = await GET(new Request(request));
    const location = new URL(response.headers.get("location")!);
    assert.equal(response.status, 307);
    assert.equal(location.origin, request.origin);
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), "/challenges/example?view=partial#review");
    assert.equal(location.searchParams.get("error"), "auth_callback_failed");
    assert.equal(location.href.includes("synthetic-private"), false);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
  }
});

test("missing and invalid callback credentials never initialise a provider or require request cookies", async () => {
  for (const query of ["next=javascript%3Aalert(1)", "token_hash=synthetic&type=invalid&next=%2Fprojects%23saved"]) {
    const response = await GET(new Request(`https://booth.example/auth/callback?${query}`));
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), query.startsWith("next=") ? "/" : "/projects#saved");
    assert.equal(location.searchParams.has("token_hash"), false);
  }
});
