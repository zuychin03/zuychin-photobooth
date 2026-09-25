import { createRoomHandler, isRoomAction } from "@/lib/server/room-requests";
import { privateJson } from "@/lib/server/cron-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ roomId: string; action: string }> }) {
  const { roomId, action } = await context.params;
  return isRoomAction(action) ? createRoomHandler(action)(request, roomId) : privateJson({ error: "invalid_request" }, 404);
}
