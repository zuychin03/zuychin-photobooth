import { createRoomHandler } from "@/lib/server/room-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createRoomHandler("capabilities");
export const GET = (request: Request) => handler(request);
