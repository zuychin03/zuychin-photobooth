import { createEventPostcardHandler } from "@/lib/server/event-postcard-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createEventPostcardHandler("challenge");
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handle(request, (await context.params).id); }
export const GET = POST;
