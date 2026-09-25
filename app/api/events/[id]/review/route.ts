import { createEventReviewHandler } from "@/lib/server/event-review-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createEventReviewHandler();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handler(request, (await context.params).id);
}
