import { notFound } from "next/navigation";
import { EventGuestEntry } from "@/components/events/EventGuestEntry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Join an event · Zuychin", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) notFound();
  return <EventGuestEntry eventId={id} available={process.env.PB_EVENTS_ENABLED === "true"} />;
}
