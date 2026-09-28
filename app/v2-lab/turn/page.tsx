import { notFound } from "next/navigation";
import TurnProbe from "./TurnProbe";
export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <TurnProbe />; }
