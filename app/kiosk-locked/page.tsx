export const dynamic = "force-dynamic";
export const metadata = { title: "Shared device locked", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default function KioskLockedPage() { return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="font-display text-3xl">Shared device locked</h1><p className="mt-5 leading-relaxed">Ask the operator to restore this kiosk. Its saved address could not be verified, so account pages and drafts remain hidden.</p></main>; }
