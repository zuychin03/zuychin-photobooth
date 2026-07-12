// Each filter is one CSS filter string used twice: as `filter` on the live
// <video> preview and as `ctx.filter` at compose time, so what you pose
// with is exactly what prints.
export interface BoothFilter {
  id: string;
  name: string;
  css: string;
}

export const FILTERS: BoothFilter[] = [
  { id: "none", name: "Original", css: "none" },
  { id: "bw", name: "B&W", css: "grayscale(1) contrast(1.08) brightness(1.02)" },
  { id: "sepia", name: "Sepia", css: "sepia(0.75) contrast(0.95) brightness(1.05)" },
  {
    id: "film",
    name: "Warm film",
    css: "sepia(0.22) saturate(1.28) contrast(1.05) brightness(1.04) hue-rotate(-6deg)",
  },
  {
    id: "cool",
    name: "Cool tone",
    css: "saturate(1.08) contrast(1.05) brightness(1.02) hue-rotate(8deg)",
  },
  {
    id: "glow",
    name: "Soft glow",
    css: "brightness(1.09) contrast(0.9) saturate(1.18)",
  },
];

export function getFilter(id: string): BoothFilter {
  return FILTERS.find((f) => f.id === id) ?? FILTERS[0];
}

/** ctx.filter is unsupported in some older Safari; fall back to unfiltered. */
export function supportsCanvasFilter(): boolean {
  if (typeof document === "undefined") return false;
  const ctx = document.createElement("canvas").getContext("2d");
  return !!ctx && typeof ctx.filter === "string";
}
