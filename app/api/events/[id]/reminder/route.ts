import { createEventReminderHandler } from "@/lib/server/event-reminder-requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createEventReminderHandler();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(request, (await context.params).id);
}
