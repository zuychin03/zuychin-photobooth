import { createMemoriesHandler } from "@/lib/server/ritual-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createMemoriesHandler();
export const GET = POST;
export const HEAD = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
