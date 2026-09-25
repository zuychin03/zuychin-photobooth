import { createEventHandler } from "@/lib/server/event-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createEventHandler("host");
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handle(request, (await context.params).id); }
export const GET = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
export const HEAD = POST;
