"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";

export default function ErrorPage({ retry }: { retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-16">
    <h1 ref={heading} tabIndex={-1} className="font-display text-4xl font-semibold outline-none">Something didn’t load.</h1>
    <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">Try opening this page again. If you were saving or uploading, check its status before starting a new request.</p>
    <div className="mt-7 flex flex-wrap gap-3">
      <button type="button" onClick={retry} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Try again</button>
      <Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-5 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Home</Link>
    </div>
  </main>;
}
