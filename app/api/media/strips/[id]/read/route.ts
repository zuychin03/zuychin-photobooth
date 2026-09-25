import { createRetainedStripHandler } from "@/lib/server/retained-strip-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const read = createRetainedStripHandler();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return read(request, (await context.params).id);
}
