import { createProjectMaintenanceHandler } from "@/lib/server/project-maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const GET = createProjectMaintenanceHandler();
