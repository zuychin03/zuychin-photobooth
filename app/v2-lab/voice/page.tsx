import { notFound } from "next/navigation";
import VoiceRehearsal from "./VoiceRehearsal";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <VoiceRehearsal />;
}
