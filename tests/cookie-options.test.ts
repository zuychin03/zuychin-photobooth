import assert from "node:assert/strict";
import test from "node:test";
import { authCookieOptions } from "../lib/supabase/cookie-options";

test("a session cookie shared across subdomains is Secure; host-only setups keep library defaults", () => {
  const previous = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  try {
    process.env.NEXT_PUBLIC_COOKIE_DOMAIN = ".example.com";
    assert.deepEqual(authCookieOptions(), { domain: ".example.com", secure: true });
    delete process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
    assert.equal(authCookieOptions(), undefined);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
    else process.env.NEXT_PUBLIC_COOKIE_DOMAIN = previous;
  }
});
