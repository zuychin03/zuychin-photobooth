import { MemoryHub } from "@/components/memories/MemoryHub";

export const dynamic = "force-dynamic";
export const metadata = { title: "Memories · Zuychin", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default function Page() { return <MemoryHub available={process.env.PB_MEMORIES_ENABLED === "true"} voiceAvailable={process.env.PB_VOICE_CAPTIONS_ENABLED === "true"} />; }
