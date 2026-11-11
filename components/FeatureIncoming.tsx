import Link from "next/link";
import { Camera, CirclePause, Sparkles } from "lucide-react";

export function FeatureIncoming({ feature, recovery = false }: { feature?: string; recovery?: boolean }) {
  return <main className="mx-auto flex min-h-[70dvh] w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-12">
    <section className="page-head panel flex w-full flex-col items-center gap-5 px-6 py-10 text-center sm:px-10 sm:py-12">
      <span className={`glyph size-16 rounded-[1.25rem] ${recovery ? "bg-[#64748b]" : "bg-[#f59e0b]"}`}>{recovery ? <CirclePause size={30} strokeWidth={2.25} aria-hidden /> : <Sparkles size={30} strokeWidth={2.25} aria-hidden />}</span>
      <div>
        <h1 className="font-display text-3xl leading-tight sm:text-4xl">{recovery ? "Temporarily paused" : "Feature incoming"}</h1>
        {feature && <p className="mt-2 text-lg font-bold">{feature}</p>}
        {recovery && <p className="mx-auto mt-3 max-w-sm text-sm text-muted-foreground">You can still make a strip, open saved projects and download existing photos.</p>}
      </div>
      <Link href="/booth" className="btn btn-primary"><Camera size={18} aria-hidden /> Open solo booth</Link>
    </section>
  </main>;
}
