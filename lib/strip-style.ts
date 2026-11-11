export interface StripOptions {
  readonly finish: "classic" | "rounded" | "keyline" | "lifted";
  readonly sprockets: boolean;
  readonly spacing: "classic" | "tight" | "airy";
  readonly band: "bottom" | "top";
  readonly footer: "stacked" | "inline";
  readonly date: "band" | "photo";
  readonly font: "serif" | "sans" | "mono";
  readonly dateFormat: "dots" | "film" | "long";
}

export const DEFAULT_STRIP: StripOptions = Object.freeze({ finish: "classic", sprockets: false, spacing: "classic", band: "bottom", footer: "stacked", date: "band", font: "serif", dateFormat: "dots" });

export const STRIP_CHOICES = {
  finish: [["classic", "Classic"], ["rounded", "Rounded"], ["keyline", "Keyline"], ["lifted", "Lifted"]],
  spacing: [["tight", "Tight"], ["classic", "Classic"], ["airy", "Airy"]],
  band: [["bottom", "Bottom"], ["top", "Top"]],
  footer: [["stacked", "Stacked"], ["inline", "One line"]],
  date: [["band", "In footer"], ["photo", "On photo"]],
  font: [["serif", "Serif"], ["sans", "Sans"], ["mono", "Mono"]],
  dateFormat: [["dots", "11·11·2026"], ["film", "'26 11 11"], ["long", "11 Nov 2026"]],
} as const satisfies { [K in Exclude<keyof StripOptions, "sprockets">]: readonly (readonly [StripOptions[K], string])[] };

const KEYS = Object.keys(DEFAULT_STRIP) as (keyof StripOptions)[];

export class StripValidationError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = "StripValidationError"; }
}

/** Strict parse of a stored strip object: plain data with exactly the known keys. */
export function validateStripOptions(value: unknown, path = "strip"): StripOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new StripValidationError(path, "Expected plain data");
  const own = Reflect.ownKeys(value);
  if (own.length !== KEYS.length || own.some(key => typeof key !== "string" || !KEYS.includes(key as keyof StripOptions) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) throw new StripValidationError(path, "Unexpected, missing or accessor fields");
  const item = value as Record<string, unknown>;
  if (typeof item.sprockets !== "boolean") throw new StripValidationError(`${path}.sprockets`, "Expected boolean");
  for (const key of Object.keys(STRIP_CHOICES) as (keyof typeof STRIP_CHOICES)[]) {
    if (!STRIP_CHOICES[key].some(([id]) => id === item[key])) throw new StripValidationError(`${path}.${key}`, "Unsupported value");
  }
  return Object.freeze({ ...item }) as unknown as StripOptions;
}

export function isDefaultStrip(strip: StripOptions | null | undefined): boolean {
  return !strip || KEYS.every(key => strip[key] === DEFAULT_STRIP[key]);
}

/** Strip options as stored: omitted when every field is the default. */
export function storedStrip(strip: StripOptions | null | undefined): StripOptions | undefined {
  return isDefaultStrip(strip) ? undefined : validateStripOptions({ ...DEFAULT_STRIP, ...strip });
}

/** Copy of `target` holding `next`, with the key left out when the style is the default. */
export function withStrip<T extends { readonly strip?: StripOptions }>(target: T, next: StripOptions | null | undefined): T {
  const copy: { strip?: StripOptions } = { ...target }, strip = storedStrip(next);
  delete copy.strip;
  return (strip ? { ...copy, strip } : copy) as T;
}

export function resolveStrip(strip: Partial<StripOptions> | null | undefined): StripOptions {
  return strip ? { ...DEFAULT_STRIP, ...strip } : DEFAULT_STRIP;
}

export const SPACING: Record<StripOptions["spacing"], { readonly margin: number; readonly gap: number }> = {
  classic: { margin: 28, gap: 18 },
  tight: { margin: 16, gap: 8 },
  airy: { margin: 44, gap: 30 },
};

export const FOOTER_HEIGHT: Record<StripOptions["footer"], number> = { stacked: 132, inline: 84 };

/** Sprocket holes sit in a margin at least this wide along the strip's long edges. */
export const SPROCKET_MARGIN = 40;

export function formatStripDate(iso: string, timeZone: string | undefined, format: StripOptions["dateFormat"]): string {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone, day: "2-digit", month: format === "long" ? "short" : "2-digit", year: "numeric" }).formatToParts(new Date(iso));
  const part = (name: string) => parts.find(value => value.type === name)?.value ?? "";
  if (format === "film") return `'${part("year").slice(-2)} ${part("month")} ${part("day")}`;
  if (format === "long") return `${Number(part("day"))} ${part("month").replace(".", "")} ${part("year")}`;
  return `${part("day")}·${part("month")}·${part("year")}`;
}
