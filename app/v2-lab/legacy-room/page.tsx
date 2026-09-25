import { notFound } from "next/navigation";
import LegacyRoomRehearsal from "./LegacyRoomRehearsal";
export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <LegacyRoomRehearsal />; }
