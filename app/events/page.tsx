import { connection } from "next/server";
import { EventHostEntry } from "@/components/events/EventHostEntry";

export default async function EventsPage() {
  await connection();
  return <EventHostEntry configured={process.env.PB_EVENTS_ENABLED === "true"} />;
}
