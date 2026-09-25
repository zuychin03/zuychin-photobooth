import { createMaintenanceHandler } from "@/lib/server/media-maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createMaintenanceHandler();
