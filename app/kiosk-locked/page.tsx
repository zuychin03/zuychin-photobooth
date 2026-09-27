export const dynamic = "force-dynamic";
export const metadata = { title: "Shared device locked", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default function KioskLockedPage() { return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="font-display text-3xl">Shared device locked</h1><p className="mt-5 leading-relaxed">Ask whoever set up this kiosk to reset it. It lost track of which page to show, so account pages and drafts stay hidden until then.</p></main>; }
