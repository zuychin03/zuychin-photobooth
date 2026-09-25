import { PDF_PROFILES, STILL_PROFILES, type ExportFit, type ExportProfileId } from "./profiles";

export interface ProjectExportSettings {
  readonly version: 1;
  readonly profileId: ExportProfileId;
  readonly fit: ExportFit;
  readonly format: "png" | "jpeg";
  readonly quality: number;
  readonly marginMm: number;
  readonly cutMarks: boolean;
}
export const DEFAULT_EXPORT_SETTINGS: ProjectExportSettings = Object.freeze({ version: 1, profileId: "original", fit: "contain", format: "png", quality: .92, marginMm: 2, cutMarks: true });
const keys = ["version", "profileId", "fit", "format", "quality", "marginMm", "cutMarks"];

export function validateExportSettings(value: unknown): ProjectExportSettings {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid export settings");
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error("Invalid export settings fields");
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || ![...STILL_PROFILES, ...PDF_PROFILES].some(profile => profile.id === v.profileId) || !["contain", "cover"].includes(v.fit as string) || !["png", "jpeg"].includes(v.format as string)
    || typeof v.quality !== "number" || !Number.isFinite(v.quality) || v.quality < .6 || v.quality > 1
    || typeof v.marginMm !== "number" || !Number.isFinite(v.marginMm) || v.marginMm < 0 || v.marginMm > (v.profileId === "a4-contact" ? 20 : 10)
    || typeof v.cutMarks !== "boolean") throw new Error("Unsupported export settings");
  return Object.freeze({ version: 1, profileId: v.profileId as ExportProfileId, fit: v.fit as ExportFit, format: v.format as "png" | "jpeg", quality: v.quality, marginMm: v.marginMm, cutMarks: v.cutMarks });
}

// Legacy manifests keep their exact payload until the user saves a settings edit.
export function projectExportSettings(value: ProjectExportSettings | undefined): ProjectExportSettings {
  return value === undefined ? DEFAULT_EXPORT_SETTINGS : validateExportSettings(value);
}
