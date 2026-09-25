import type { Metadata } from "next";
import { FeatureIncoming } from "@/components/FeatureIncoming";

export const metadata: Metadata = { title: "Feature incoming · Zuychin Photobooth", robots: { index: false, follow: false } };

export default async function IncomingPage({ searchParams }: { searchParams: Promise<{ feature?: string }> }) {
  const { feature } = await searchParams;
  return <FeatureIncoming feature={typeof feature === "string" && feature.length <= 40 ? feature : undefined} />;
}
