import { createEventHandler } from "@/lib/server/event-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createEventHandler("root");
export async function POST(request: Request) { return handle(request); }
export const GET = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
export const HEAD = POST;
