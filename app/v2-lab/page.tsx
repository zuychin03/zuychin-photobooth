import { notFound } from "next/navigation";
import FeasibilityLab from "./FeasibilityLab";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <FeasibilityLab />;
}
