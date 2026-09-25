import Link from "next/link";
import { Camera } from "lucide-react";

export function FeatureIncoming({ feature }: { feature?: string }) {
  const control = "inline-flex min-h-12 items-center justify-center rounded-2xl px-5 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

  return <main className="mx-auto w-full max-w-5xl px-5 py-12 sm:px-8 sm:py-20">
    <div className="max-w-xl">
      <Camera size={32} strokeWidth={1.5} className="mb-6 text-accent" aria-hidden="true" />
      <h1 className="font-display text-4xl font-semibold sm:text-5xl">Feature incoming</h1>
      {feature && <p className="mt-3 text-lg font-medium">{feature}</p>}
      <p className="mt-4 max-w-md leading-relaxed text-foreground/70">We&apos;re getting this ready. In the meantime, make a photo strip.</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Link href="/booth" className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`}>Open solo booth</Link>
        <Link href="/projects" className={`${control} border border-border hover:bg-muted`}>Your projects</Link>
      </div>
    </div>
  </main>;
}
