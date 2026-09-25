import { notFound } from "next/navigation";
import EventHostRehearsal from "./EventHostRehearsal";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <EventHostRehearsal />;
}
