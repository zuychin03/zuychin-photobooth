import { createRoomHandler } from "@/lib/server/room-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createRoomHandler("join");
export const POST = (request: Request) => handler(request);
