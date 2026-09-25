import { connection } from "next/server";
import TogetherEntry from "./TogetherEntry";

export default async function TogetherPage() {
  await connection();
  return <TogetherEntry
    roomsConfigured={process.env.PB_ROOM_V2_ENABLED === "true"}
    cloudConfigured={process.env.PB_CLOUD_PROJECTS_ENABLED === "true"}
    challengesConfigured={process.env.PB_CLOUD_PROJECTS_ENABLED === "true" && process.env.PB_CHALLENGES_ENABLED === "true"}
  />;
}
