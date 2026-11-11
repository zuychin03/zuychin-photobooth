"use client";
import { useEffect, useRef } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

export default function ErrorPage({ retry }: { retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-16">
    <section className="page-head panel flex w-full flex-col items-center gap-5 px-6 py-10 text-center sm:px-10 sm:py-12">
      <span className="glyph size-16 rounded-[1.25rem] bg-[#f59e0b]"><TriangleAlert size={30} strokeWidth={2.25} aria-hidden /></span>
      <div>
        <h1 ref={heading} tabIndex={-1} className="font-display text-3xl leading-tight outline-none sm:text-4xl">Something didn&apos;t load</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm text-muted-foreground">If you were saving or uploading, check whether it went through before you start over.</p>
      </div>
      <button type="button" onClick={retry} className="btn btn-primary"><RotateCcw size={17} aria-hidden /> Try again</button>
    </section>
  </main>;
}
