import Link from "next/link";

export default function NotFound() {
  return <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-16">
    <p className="text-sm text-muted-foreground">Page unavailable</p>
    <h1 className="mt-3 font-display text-4xl font-semibold">Let’s find your way back.</h1>
    <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">This page could not be found. Return to the booth or open your saved projects.</p>
    <nav aria-label="Page recovery" className="mt-7 flex flex-wrap gap-3">
      <Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Home</Link>
      <Link href="/projects" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-5 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">My projects</Link>
    </nav>
  </main>;
}
