import { createStripOperationHandler } from "@/lib/server/media-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createStripOperationHandler();

export async function POST(request: Request) {
  return handle(request);
}
