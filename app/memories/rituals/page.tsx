import { RitualHub } from "@/components/memories/RitualHub";

export const dynamic = "force-dynamic";
export const metadata = { title: "Photo rituals · Zuychin", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default function Page() { return <RitualHub available={process.env.PB_MEMORIES_ENABLED === "true"} />; }
