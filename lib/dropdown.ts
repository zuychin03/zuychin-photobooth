export interface DropdownOption { value: string; label: string; disabled?: boolean }

export function dropdownUsesPopover(supported: boolean, developmentFallback: boolean, environment: string | undefined): boolean {
  return supported && !(environment === "development" && developmentFallback);
}

export function dropdownPortalRoot(trigger: { closest(selector: string): Element | null } | null, body: Element): Element {
  return trigger?.closest("dialog[open]") ?? body;
}

export function dropdownStep(options: readonly DropdownOption[], current: number, direction: 1 | -1 | "first" | "last", distance = 1): number {
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  if (!enabled.length) return -1;
  if (direction === "first") return enabled[0];
  if (direction === "last") return enabled[enabled.length - 1];
  const position = enabled.indexOf(current);
  if (position < 0) return direction === 1 ? enabled[0] : enabled[enabled.length - 1];
  const steps = Number.isFinite(distance) ? Math.max(1, Math.floor(distance)) : 1;
  return enabled[Math.max(0, Math.min(enabled.length - 1, position + direction * steps))];
}

const folded = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
export function dropdownMatch(options: readonly DropdownOption[], search: string, current: number, includeCurrent = false): number {
  if (!search || !options.length) return current;
  const prefix = folded(search);
  const start = includeCurrent && current >= 0 ? current : Math.max(-1, current) + 1;
  for (let offset = 0; offset < options.length; offset++) {
    const index = (start + offset) % options.length;
    if (!options[index].disabled && folded(options[index].label).startsWith(prefix)) return index;
  }
  return current;
}

export interface DropdownViewport { width: number; height: number; left?: number; top?: number }
export function dropdownPlacement(anchor: { left: number; top: number; bottom: number; width: number }, viewport: DropdownViewport, contentHeight: number) {
  const margin = 8, gap = 6;
  const left = viewport.left ?? 0, topEdge = viewport.top ?? 0, right = left + viewport.width, bottom = topEdge + viewport.height;
  const width = Math.max(1, Math.min(Math.max(anchor.width, 220), viewport.width - margin * 2));
  const below = Math.max(0, bottom - anchor.bottom - margin - gap), above = Math.max(0, anchor.top - topEdge - margin - gap);
  const desired = Math.min(Math.max(44, contentHeight), 320);
  const side = below >= Math.min(desired, 176) || below >= above ? "below" : "above";
  const maxHeight = Math.max(1, Math.min(desired, side === "below" ? below : above));
  const top = side === "below" ? anchor.bottom + gap : anchor.top - gap - maxHeight;
  return { left: Math.max(left + margin, Math.min(anchor.left, right - width - margin)), top: Math.max(topEdge + margin, Math.min(top, bottom - maxHeight - margin)), width, maxHeight };
}
