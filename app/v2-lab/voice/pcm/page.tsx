import { notFound } from "next/navigation";
import PcmRehearsal from "./PcmRehearsal";
export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <PcmRehearsal />; }
