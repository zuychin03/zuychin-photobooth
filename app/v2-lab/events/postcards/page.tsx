import { notFound } from "next/navigation";
import PostcardRehearsal from "./PostcardRehearsal";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <PostcardRehearsal />;
}
