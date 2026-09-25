import { notFound } from "next/navigation";
import RelayRecoveryRehearsal from "./RelayRecoveryRehearsal";
export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <RelayRecoveryRehearsal />; }
