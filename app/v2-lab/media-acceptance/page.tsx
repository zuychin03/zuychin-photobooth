import { notFound } from "next/navigation";
import MediaAcceptance from "./MediaAcceptance";
export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <MediaAcceptance />; }
