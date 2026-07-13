"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
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

  const next = search.get("next") ?? "/";

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
        if (error) throw error;
        setMsg({ kind: "success", text: "Check your email for the magic link." });
      }
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : "Sign-in failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh flex-1 items-center justify-center overflow-hidden px-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="fluid-orb absolute -top-24 -left-24 h-96 w-96 rounded-full bg-accent/20 blur-3xl" />
        <div className="fluid-orb--slow fluid-orb absolute bottom-0 -right-24 h-[24rem] w-[24rem] rounded-full bg-partner/20 blur-3xl" />
      </div>

      <button
        onClick={() => router.push("/")}
        aria-label="Back"
        className="glass-card absolute top-4 left-4 flex h-11 w-11 items-center justify-center rounded-full"
      >
        <ArrowLeft size={20} />
      </button>

      <div className="glass-card w-full max-w-sm rounded-3xl p-7">
        <h1
          className="text-2xl font-semibold"
          style={{ fontFamily: "var(--font-fraunces)" }}
        >
          Sign in
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Use your Zuychin account to save strips to your timeline.
        </p>

        {!enabled ? (
          <p className="mt-6 rounded-xl bg-muted p-3 text-sm text-muted-foreground">
            Accounts aren&apos;t configured on this deployment yet. The booth still
            works without signing in.
          </p>
        ) : (
          <>
            <div className="mt-5 flex rounded-full bg-muted p-0.5 text-sm font-medium">
              {(["password", "magic-link"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`min-h-9 flex-1 rounded-full transition ${
                    mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  {m === "password" ? "Password" : "Magic link"}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="min-h-12 rounded-xl border border-border bg-card px-4 outline-none focus:border-accent"
              />
              {mode === "password" && (
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="min-h-12 rounded-xl border border-border bg-card px-4 outline-none focus:border-accent"
                />
              )}
              <button
                type="submit"
                disabled={busy}
                className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-accent font-semibold text-accent-foreground transition active:scale-[0.99] disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 size={18} className="animate-spin" />
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
                className={`mt-3 text-sm ${
                  msg.kind === "error" ? "text-destructive" : "text-success"
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
