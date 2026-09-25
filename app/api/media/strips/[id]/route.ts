import { createStripOperationHandler } from "@/lib/server/media-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createStripOperationHandler();

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handle(request, id);
}
