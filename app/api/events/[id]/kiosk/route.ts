import { createEventKioskHandler } from "@/lib/server/event-kiosk-requests";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handle = createEventKioskHandler();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handle(request,(await context.params).id); }
