import { notFound } from "next/navigation";
import { ChallengeEntry } from "@/components/cloud/ChallengeEntry";
import { cloudUuid } from "@/lib/projects/cloud-contract";

export const dynamic = "force-dynamic";
export const metadata = { title: "Photo challenge · Zuychin", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { cloudUuid(id); } catch { notFound(); }
  const available = process.env.PB_CLOUD_PROJECTS_ENABLED === "true" && process.env.PB_CHALLENGES_ENABLED === "true";
  return <ChallengeEntry challengeId={id} available={available} />;
}
