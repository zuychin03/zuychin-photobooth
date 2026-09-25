import { notFound } from "next/navigation";
import EventExportRehearsal from "./EventExportRehearsal";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <EventExportRehearsal />;
}
