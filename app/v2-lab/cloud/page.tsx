import { notFound } from "next/navigation";
import { SyntheticCloud } from "../SyntheticCloud";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <SyntheticCloud />;
}
