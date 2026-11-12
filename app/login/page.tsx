"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Camera, Loader2, Mail } from "lucide-react";
import { safeAuthReturnPath } from "@/lib/auth-return-path";
import { createClient, hasSupabase } from "@/lib/supabase/client";

type Mode = "password" | "magic-link";

function LoginInner() {
  const router = useRouter();
  const search = useSearchParams();
  const enabled = hasSupabase();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(
    search.get("error") ? { kind: "error", text: "Sign-in link expired. Try again." } : null,
  );

  const next = safeAuthReturnPath(search.get("next"));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enabled) return;
    setBusy(true);
    setMsg(null);
    const supabase = createClient();
    try {
      if (mode === "password") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      } else {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
        });
        // With sign-ups off, an unknown address gets its own error; answering it like a sent
        // link keeps the form from showing who has an account.
        if (error && error.code !== "signup_disabled" && error.code !== "otp_disabled") throw error;
        setMsg({ kind: "success", text: "If this email can sign in here, a magic link is on its way." });
      }
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : "Sign-in failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh flex-1 items-center justify-center px-4 py-10">
      <div className="page-head glass-strong w-full max-w-sm rounded-[1.75rem] p-6 sm:p-7">
        <div className="flex flex-col items-center text-center">
          <span className="glyph size-14 rounded-2xl bg-[#f43f5e]"><Camera size={26} strokeWidth={2.25} aria-hidden /></span>
          <h1 className="mt-4 font-display text-3xl leading-tight">Sign in</h1>
        </div>

        {!enabled ? (
          <p className="notice mt-6 text-center text-muted-foreground">
            Sign-in is unavailable. You can still use the solo booth.
          </p>
        ) : (
          <>
            <div className="segmented mt-6 flex w-full">
              {(["password", "magic-link"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className="flex-1 transition-[color,background-color,box-shadow] duration-300 ease-[var(--spring-soft)]"
                >
                  {m === "password" ? "Password" : "Magic link"}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
              <input
                type="email"
                aria-label="Email address"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="field min-h-12 px-4"
              />
              {mode === "password" && (
                <input
                  type="password"
                  aria-label="Password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="field min-h-12 px-4"
                />
              )}
              <button
                type="submit"
                disabled={busy}
                className="btn btn-primary mt-1 min-h-12 w-full"
              >
                {busy ? (
                  <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />
                ) : mode === "magic-link" ? (
                  <>
                    <Mail size={18} /> Send magic link
                  </>
                ) : (
                  "Sign in"
                )}
              </button>
            </form>

            {msg && (
              <p
                className={`notice mt-4 font-bold ${
                  msg.kind === "error" ? "border border-destructive/25 bg-destructive/8 text-destructive" : "text-success"
                }`}
              >
                {msg.text}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
