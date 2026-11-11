"use client";

import { useSyncExternalStore } from "react";
import { CELL_W, FOOTER_H, type Role, type StripLayout } from "@/lib/layouts";

// Glyph tones from DESIGN.md, fixed hex so they read the same in both themes.
const ROLE_TONES: Record<Role, string> = { A: "#f43f5e", B: "#8b5cf6", C: "#f59e0b", D: "#0ea5e9" };

export interface GlyphTile { readonly key: string; readonly role: Role; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * Tiles in whole device pixels with one fixed gap between every photo, split frames included.
 * Built from the row model rather than scaled strip geometry, whose gaps vanish below a pixel on wide strips.
 * Every edge is a whole number of device pixels from the glyph's origin, so the browser snaps all gaps alike at any zoom.
 */
export function layoutGlyph(layout: StripLayout, box: number, pixelRatio = 1): { width: number; height: number; gap: number; tiles: GlyphTile[] } {
  const gap = Math.max(2, Math.round(2 * pixelRatio)), pad = Math.round(3 * pixelRatio), size = Math.round(box * pixelRatio);
  const footerShare = FOOTER_H / (CELL_W * layout.columns);
  let slope = footerShare, fixed = 2 * pad + (layout.rows.length - 1) * gap;
  for (const row of layout.rows) {
    const count = row.cells.length;
    slope += 1 / (count * row.aspect);
    fixed -= (count - 1) * gap / (count * row.aspect);
  }
  const content = Math.min(size - 2 * pad, (size - fixed) / slope), right = pad + Math.round(content);
  // Each edge is the next start minus the gap, so gaps stay exact whatever the rounding.
  const edges = (start: number, end: number, count: number) => Array.from({ length: count }, (_, i) => [
    start + Math.round(i * (end - start + gap) / count),
    i === count - 1 ? end : start + Math.round((i + 1) * (end - start + gap) / count) - gap,
  ]);
  const tiles: GlyphTile[] = [];
  let top = pad, index = 0, exact = pad;
  for (const row of layout.rows) {
    const count = row.cells.length, slots = row.cells.flatMap((cell, column) => cell.owners.map(role => ({ role, cell: index + column })));
    exact += (content - (count - 1) * gap) / count / row.aspect;
    const bottom = Math.round(exact);
    edges(pad, right, slots.length).forEach(([x, xEnd], slot) => {
      const { role, cell } = slots[slot];
      tiles.push({ key: `${cell}-${role}`, role, x, y: top, width: xEnd - x, height: bottom - top });
    });
    index += count;
    top = bottom + gap; exact += gap;
  }
  return { width: right + pad, height: top - gap + Math.round(content * footerShare) + pad, gap, tiles };
}

// Zoom changes the device pixel ratio and fires resize.
const subscribe = (onChange: () => void) => { window.addEventListener("resize", onChange); return () => window.removeEventListener("resize", onChange); };

/** Mini diagram of a strip's cells, fitted inside a square box of `size` CSS pixels. */
export function LayoutGlyph({ layout, selected = false, size = 48 }: { layout: StripLayout; selected?: boolean; size?: number }) {
  const ratio = useSyncExternalStore(subscribe, () => window.devicePixelRatio || 1, () => 1);
  const { width, height, tiles } = layoutGlyph(layout, size, ratio);
  const shared = layout.mode !== "solo";
  const css = (value: number) => `${value / ratio}px`;
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <span className="relative block rounded-[3px] bg-current/12" style={{ width: css(width), height: css(height) }}>
        {tiles.map(tile => (
          <span
            key={tile.key}
            className={`absolute rounded-[2px] ${shared ? "" : selected ? "bg-accent" : "bg-current opacity-60"}`}
            style={{ left: css(tile.x), top: css(tile.y), width: css(tile.width), height: css(tile.height), ...(shared ? { background: ROLE_TONES[tile.role], opacity: selected ? 1 : 0.75 } : {}) }}
          />
        ))}
      </span>
    </span>
  );
}
