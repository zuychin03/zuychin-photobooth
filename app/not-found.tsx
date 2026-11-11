import Link from "next/link";
import { House, SearchX } from "lucide-react";

export default function NotFound() {
  return <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-16">
    <section className="page-head panel flex w-full flex-col items-center gap-5 px-6 py-10 text-center sm:px-10 sm:py-12">
      <span className="glyph size-16 rounded-[1.25rem] bg-[#64748b]"><SearchX size={30} strokeWidth={2.25} aria-hidden /></span>
      <h1 className="font-display text-3xl leading-tight sm:text-4xl">Page not found</h1>
      <nav aria-label="Where to go next">
        <Link href="/" className="btn btn-primary"><House size={18} aria-hidden /> Home</Link>
      </nav>
    </section>
  </main>;
}
