import { notFound } from "next/navigation";
import { EventPostcardEntry } from "@/components/events/EventPostcardEntry";
import { parsePostcardSource } from "@/lib/events/postcard-contract";
import { eventClientUuid } from "@/lib/events/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared event postcard | Photobooth", robots: { index: false, follow: false } };
export default async function PostcardPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params, query = await searchParams;
  let eventId: string, postcardId: string, source: ReturnType<typeof parsePostcardSource>;
  try {
    if (Object.keys(query).sort().join() !== (query.kind === "room" ? "capture,kind,postcard,source" : "kind,postcard,source")) notFound();
    eventId = eventClientUuid(slug); postcardId = eventClientUuid(query.postcard);
    source = parsePostcardSource({ kind: query.kind, id: query.source, ...(query.kind === "room" ? { captureId: query.capture } : {}) });
  } catch { notFound(); }
  return <EventPostcardEntry eventId={eventId} postcardId={postcardId} source={source} available={process.env.PB_EVENTS_ENABLED === "true"} />;
}
