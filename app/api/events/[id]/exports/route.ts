import { createEventExportHandler } from "@/lib/server/event-export-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createEventExportHandler();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(request, (await context.params).id);
}
