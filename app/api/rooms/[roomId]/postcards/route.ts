import { createEventPostcardHandler } from "@/lib/server/event-postcard-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createEventPostcardHandler("room");
export async function POST(request: Request, context: { params: Promise<{ roomId: string }> }) { return handle(request, (await context.params).roomId); }
export const GET = POST;
