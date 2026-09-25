import { createEventMaintenanceHandler } from "@/lib/server/event-maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const GET = createEventMaintenanceHandler();
