import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Fraunces, Noto_Emoji } from "next/font/google";
import { SessionProvider } from "@/lib/session";
import { AuthProvider } from "@/lib/auth";
import AuthCookieMigration from "@/components/AuthCookieMigration";
import PwaRegister from "@/components/PwaRegister";
import EventKioskGuard from "@/components/events/EventKioskGuard";
import { AppNavigationProvider } from "@/components/AppNavigation";
import { SiteNav } from "@/components/SiteNav";
import { Suspense } from "react";
import { connection } from "next/server";
import { isLocalRelease } from "@/lib/release-mode";
import { ReleaseFeatureBoundary, ReleaseModeProvider } from "@/components/ReleaseMode";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
});

// Monochrome emoji glyphs for the tinted "Ink" sticker style
const notoEmoji = Noto_Emoji({
  variable: "--font-noto-emoji",
  subsets: ["emoji"],
});

export const metadata: Metadata = {
  title: "Zuychin Photobooth",
  description:
    "Create photo strips on your own, capture together from anywhere, and share memories at events.",
  icons: {
    icon: "/favicon-v2.svg",
    apple: "/apple-touch-icon-v2.png",
  },
  appleWebApp: {
    capable: true,
    title: "Photobooth",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0a09",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await connection();
  const localOnly = isLocalRelease();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${notoEmoji.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <PwaRegister />
        {!localOnly && <AuthCookieMigration />}
        <Suspense fallback={<main className="min-h-dvh" aria-label="Checking shared-device privacy" />}>
          <EventKioskGuard><AuthProvider accountsEnabled={!localOnly}>
            <ReleaseModeProvider localOnly={localOnly}><SessionProvider><AppNavigationProvider><SiteNav /><div className="app-content flex min-h-0 flex-1 flex-col"><ReleaseFeatureBoundary>{children}</ReleaseFeatureBoundary></div></AppNavigationProvider></SessionProvider></ReleaseModeProvider>
          </AuthProvider></EventKioskGuard>
        </Suspense>
      </body>
    </html>
  );
}
