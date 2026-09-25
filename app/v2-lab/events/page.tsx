import { notFound } from "next/navigation";
import { SyntheticEventGuest } from "./SyntheticEventGuest";

export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <SyntheticEventGuest />; }
