import { notFound } from "next/navigation";
import { EventKioskEntry } from "@/components/events/EventKioskEntry";
export const dynamic = "force-dynamic";
export const metadata = { title: "Shared event booth · Zuychin", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function Page({params}:{params:Promise<{slug:string}>}) {const {slug}=await params;if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(slug))notFound();return <EventKioskEntry key={slug} eventId={slug} available={process.env.PB_EVENTS_ENABLED==='true'}/>;}
