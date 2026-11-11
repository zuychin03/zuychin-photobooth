import { LockKeyhole } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared device locked", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default function KioskLockedPage() { return <main className="booth-mode mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col items-start gap-5 px-4 pt-12 pb-10 sm:px-8 sm:pt-16"><span className="glyph size-14 rounded-2xl bg-[#64748b]"><LockKeyhole size={26} aria-hidden /></span><h1 className="font-display text-[2.125rem] leading-[1.12] sm:text-5xl">Shared device locked</h1><p className="panel p-5 text-sm sm:p-6">Ask whoever set up this kiosk to reset it. It lost track of which page to show, so account pages and drafts stay hidden until then.</p></main>; }
