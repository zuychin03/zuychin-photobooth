import { notFound } from "next/navigation";
import { SyntheticMemories } from "./SyntheticMemories";

export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <SyntheticMemories />; }
