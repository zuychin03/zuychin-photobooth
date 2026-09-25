import { createProjectHandler } from "@/lib/server/project-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createProjectHandler();
