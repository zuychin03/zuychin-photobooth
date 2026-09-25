import { createReminderHandler } from "@/lib/server/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createReminderHandler();
