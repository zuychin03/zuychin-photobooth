import { notFound } from "next/navigation";
import { SyntheticRituals } from "./SyntheticRituals";

export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <SyntheticRituals />; }
