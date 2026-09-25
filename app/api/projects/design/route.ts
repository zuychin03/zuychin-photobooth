import { createProjectDesignHandler } from "@/lib/server/project-design-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createProjectDesignHandler();
