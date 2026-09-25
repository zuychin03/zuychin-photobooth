export type StillProfileId = "original" | "story" | "square" | "wallpaper";
export type PdfProfileId = "print-strip" | "print-two-up" | "a4-contact";
export type ExportProfileId = StillProfileId | PdfProfileId;
export type ExportFit = "contain" | "cover";
export interface ExportProfile { id: ExportProfileId; label: string; kind: "still" | "pdf"; width?: number; height?: number; fit: ExportFit }
export const STILL_PROFILES: readonly ExportProfile[] = Object.freeze([
  { id: "original", label: "Original proportions", kind: "still", fit: "contain" },
  { id: "story", label: "Story · 1080 × 1920", kind: "still", width: 1080, height: 1920, fit: "contain" },
  { id: "square", label: "Square · 1080 × 1080", kind: "still", width: 1080, height: 1080, fit: "contain" },
  { id: "wallpaper", label: "Wallpaper · 1080 × 1920", kind: "still", width: 1080, height: 1920, fit: "cover" },
]);
export const PDF_PROFILES: readonly ExportProfile[] = Object.freeze([
  { id: "print-strip", label: "Strip · 50.8 × 152.4 mm", kind: "pdf", width: 50.8, height: 152.4, fit: "contain" },
  { id: "print-two-up", label: "Two strips · 101.6 × 152.4 mm", kind: "pdf", width: 101.6, height: 152.4, fit: "contain" },
  { id: "a4-contact", label: "A4 contact sheet · three strips", kind: "pdf", width: 210, height: 297, fit: "contain" },
]);
export function getExportProfile(id: ExportProfileId): ExportProfile {
  const profile = [...STILL_PROFILES, ...PDF_PROFILES].find(item => item.id === id);
  if (!profile) throw new Error("Unknown export profile");
  return profile;
}
export interface ExportOptions {
  fit?: ExportFit;
  format?: "png" | "jpeg";
  quality?: number;
  marginMm?: number;
  cutMarks?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
