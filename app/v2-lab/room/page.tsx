import { notFound } from "next/navigation";
import { SyntheticRoom } from "../SyntheticRoom";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <SyntheticRoom />;
}
