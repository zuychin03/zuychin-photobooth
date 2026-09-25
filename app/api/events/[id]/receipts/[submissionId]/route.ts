import { createEventHandler } from "@/lib/server/event-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createEventHandler("receipt");
export async function POST(request: Request, context: { params: Promise<{ id: string; submissionId: string }> }) { const params = await context.params; return handle(request, params.id, params.submissionId); }
export const GET = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
export const HEAD = POST;
