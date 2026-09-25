import { notFound } from "next/navigation";
import { EventAudienceRehearsal } from "./EventAudienceRehearsal";
export const dynamic = "force-dynamic";
export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <EventAudienceRehearsal />; }
