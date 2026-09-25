import { createEventPublicationHandler } from "@/lib/server/event-publication-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createEventPublicationHandler("wall");
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handler(request, (await context.params).id); }
export const GET = POST;
