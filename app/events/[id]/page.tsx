import { connection } from "next/server";
import { notFound } from "next/navigation";
import { EventHostEntry } from "@/components/events/EventHostEntry";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  await connection(); const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) notFound();
  return <EventHostEntry configured={process.env.PB_EVENTS_ENABLED === "true"} eventId={id} />;
}
