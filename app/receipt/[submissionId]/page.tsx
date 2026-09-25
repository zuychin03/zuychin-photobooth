import { notFound } from "next/navigation";
import { EventGuestReceipt } from "@/components/events/EventGuestReceipt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Private event receipt · Zuychin", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function Page({ params }: { params: Promise<{ submissionId: string }> }) {
  const { submissionId } = await params; if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(submissionId)) notFound();
  return <EventGuestReceipt submissionId={submissionId} available={process.env.PB_EVENTS_ENABLED === "true"} />;
}
