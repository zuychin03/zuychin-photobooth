import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Fraunces, Mochiy_Pop_One, Noto_Emoji, Zen_Maru_Gothic } from "next/font/google";
import { AmbientBackdrop } from "@/components/AmbientBackdrop";
import { CanvasFontWarmup } from "@/components/CanvasFontWarmup";
import { GlassLight } from "@/components/GlassLight";
import { InlineScript } from "@/components/InlineScript";
import { SessionProvider } from "@/lib/session";
import { AuthProvider } from "@/lib/auth";
import AuthCookieMigration from "@/components/AuthCookieMigration";
import PwaRegister from "@/components/PwaRegister";
import EventKioskGuard from "@/components/events/EventKioskGuard";
import { AppNavigationProvider } from "@/components/AppNavigation";
import { SiteNav } from "@/components/SiteNav";
import { Suspense } from "react";
import { connection } from "next/server";
import { isLocalRelease, isRecoveryRelease } from "@/lib/release-mode";
import { ReleaseFeatureBoundary, ReleaseModeProvider } from "@/components/ReleaseMode";
import { themeBootScript } from "@/lib/theme-boot";
import "./globals.css";

const zenMaru = Zen_Maru_Gothic({
  variable: "--font-zen-maru",
  weight: ["400", "500", "700", "900"],
  subsets: ["latin"],
});

const mochiy = Mochiy_Pop_One({
  variable: "--font-mochiy",
  weight: "400",
  subsets: ["latin"],
});

// Output-only: strip and recap canvases draw captions in these. CanvasFontWarmup loads them.
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f1f2" },
    { media: "(prefers-color-scheme: dark)", color: "#100d0f" },
  ],
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
      className={`${zenMaru.variable} ${mochiy.variable} ${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${notoEmoji.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <InlineScript html={themeBootScript} />
      </head>
      {/* Extensions such as Grammarly add attributes to body before hydration. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <AmbientBackdrop />
        <CanvasFontWarmup />
        <GlassLight />
        <PwaRegister />
        {!localOnly && <AuthCookieMigration />}
        <Suspense fallback={<main className="min-h-dvh" aria-label="Loading" />}>
          <EventKioskGuard><AuthProvider accountsEnabled={!localOnly}>
            <ReleaseModeProvider localOnly={localOnly} recovery={isRecoveryRelease()}><SessionProvider><AppNavigationProvider><SiteNav /><div className="app-content flex min-h-0 flex-1 flex-col"><ReleaseFeatureBoundary>{children}</ReleaseFeatureBoundary></div></AppNavigationProvider></SessionProvider></ReleaseModeProvider>
          </AuthProvider></EventKioskGuard>
        </Suspense>
      </body>
    </html>
  );
}
