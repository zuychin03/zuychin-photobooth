"use client";

import { useEffect } from "react";
import { ensureStripFonts } from "@/lib/strip-fonts";

export function CanvasFontWarmup() {
  useEffect(() => { void ensureStripFonts(); }, []);
  return null;
}
