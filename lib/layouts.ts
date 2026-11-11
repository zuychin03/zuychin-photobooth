import { FOOTER_HEIGHT, SPACING, SPROCKET_MARGIN, resolveStrip, type StripOptions } from "./strip-style";

// Strip geometry is defined in abstract units (column width = 480) and
// scaled at compose time; preview and export share the same math.
export const CELL_W = 480;
export const STRIP_MARGIN = 28;
export const CELL_GAP = 18;
export const FOOTER_H = 132;

/** Host is A; guests get B, C, D in join order. */
export type Role = "A" | "B" | "C" | "D";

export const ROLES: Role[] = ["A", "B", "C", "D"];

/** Photos one person takes. Solo goes up to 8; shared flows stop at 4. */
export type ShotCount = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type LayoutCategory = "strips" | "grids" | "feature" | "wide" | "single" | "together";

export const LAYOUT_CATEGORIES: readonly { readonly id: LayoutCategory; readonly name: string }[] = [
  { id: "strips", name: "Strips" },
  { id: "grids", name: "Grids" },
  { id: "feature", name: "Feature" },
  { id: "wide", name: "Wide" },
  { id: "single", name: "Single" },
  { id: "together", name: "Together" },
];

/** One photo cell. Several owners split the cell into equal vertical slices of the same shot. */
export interface LayoutCell {
  readonly owners: readonly Role[];
  /** source shot index; in shared rooms this is the synced round */
  readonly shot: number;
}

/** Cells in a row share its width equally and all take the row's aspect. */
export interface LayoutRow {
  readonly aspect: number;
  readonly cells: readonly LayoutCell[];
}

export interface StripLayout {
  readonly id: string;
  readonly name: string;
  readonly mode: "solo" | "duo" | "group";
  readonly category: LayoutCategory;
  /** content width in CELL_W columns */
  readonly columns: number;
  readonly rows: readonly LayoutRow[];
  /** shots each participant takes (synced fires in duo/group mode) */
  readonly shots: number;
  /** minimum participants this layout makes sense for */
  readonly minMembers?: number;
  /** part of the V2 catalogue that legacy rooms and schema 3-4 projects know */
  readonly legacy?: boolean;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CellRect extends Rect {
  readonly index: number;
  readonly owners: readonly Role[];
  readonly shot: number;
  readonly aspect: number;
}

export interface StripGeometry {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  readonly gap: number;
  readonly cells: readonly CellRect[];
  /** caption and datestamp band */
  readonly band: Rect;
  /** film edge holes along the long edges, empty unless the strip has sprockets */
  readonly sprockets: readonly Rect[];
}

type GridOwner = Role | "AB";

/** Uniform grid: solo cells take shots in reading order, shared rows are one synced round each. */
function grid(columns: number, rowCount: number, aspect: number, pattern?: readonly GridOwner[]): LayoutRow[] {
  return Array.from({ length: rowCount }, (_, row) => ({
    aspect,
    cells: Array.from({ length: columns }, (_, col) => {
      const owner = pattern?.[row * columns + col] ?? "A";
      return { owners: owner === "AB" ? ["A", "B"] as const : [owner], shot: pattern ? row : row * columns + col };
    }),
  }));
}

const repeat = <T,>(items: readonly T[], times: number): T[] => Array.from({ length: times }, () => items).flat();

const cellOf = (owners: Role | readonly Role[], shot: number): LayoutCell => ({ owners: typeof owners === "string" ? [owners] : owners, shot });

/** One row per round where the cell is split between everyone. */
const splitRows = (owners: readonly Role[], aspect: number, rounds: number): LayoutRow[] =>
  Array.from({ length: rounds }, (_, shot) => ({ aspect, cells: [cellOf(owners, shot)] }));

export const LAYOUTS: StripLayout[] = [
  { id: "strip4", name: "Classic strip", mode: "solo", category: "strips", columns: 1, rows: grid(1, 4, 3 / 2), shots: 4, legacy: true },
  { id: "grid4", name: "2×2 grid", mode: "solo", category: "grids", columns: 2, rows: grid(2, 2, 4 / 3), shots: 4, legacy: true },
  { id: "strip3", name: "Tall three", mode: "solo", category: "strips", columns: 1, rows: grid(1, 3, 4 / 3), shots: 3, legacy: true },
  { id: "duo-alternate", name: "Taking turns", mode: "duo", category: "strips", columns: 1, rows: grid(1, 4, 3 / 2, ["A", "B", "A", "B"]), shots: 4, legacy: true },
  { id: "duo-split", name: "Side by side", mode: "duo", category: "together", columns: 1, rows: grid(1, 4, 3 / 2, repeat(["AB"], 4)), shots: 4, legacy: true },
  { id: "duo-twin", name: "Twin strips", mode: "duo", category: "strips", columns: 2, rows: grid(2, 4, 3 / 2, repeat(["A", "B"], 4)), shots: 4, legacy: true },
  { id: "trio", name: "Trio strips", mode: "group", category: "strips", columns: 3, rows: grid(3, 4, 3 / 2, repeat(["A", "B", "C"], 4)), shots: 4, minMembers: 3, legacy: true },
  { id: "quad", name: "Quad strips", mode: "group", category: "strips", columns: 4, rows: grid(4, 3, 3 / 2, repeat(["A", "B", "C", "D"], 3)), shots: 3, minMembers: 4, legacy: true },
  { id: "quad-story", name: "Four-cut group story", mode: "group", category: "strips", columns: 4, rows: grid(4, 4, 3 / 2, repeat(["A", "B", "C", "D"], 4)), shots: 4, minMembers: 4, legacy: true },
  { id: "strip2", name: "Two-up", mode: "solo", category: "strips", columns: 1, rows: grid(1, 2, 3 / 2), shots: 2 },
  { id: "square4", name: "Square grid", mode: "solo", category: "grids", columns: 2, rows: grid(2, 2, 1), shots: 4 },
  { id: "feature3", name: "Feature + two", mode: "solo", category: "feature", columns: 2, rows: [{ aspect: 3 / 2, cells: [cellOf("A", 0)] }, { aspect: 3 / 2, cells: [cellOf("A", 1), cellOf("A", 2)] }], shots: 3 },
  { id: "feature4", name: "Feature + three", mode: "solo", category: "feature", columns: 2, rows: [{ aspect: 3 / 2, cells: [cellOf("A", 0)] }, { aspect: 1, cells: [cellOf("A", 1), cellOf("A", 2), cellOf("A", 3)] }], shots: 4 },
  { id: "film4", name: "Film row", mode: "solo", category: "wide", columns: 4, rows: grid(4, 1, 3 / 4), shots: 4 },
  { id: "polaroid", name: "Polaroid", mode: "solo", category: "single", columns: 1, rows: grid(1, 1, 1), shots: 1 },
  { id: "grid6", name: "Six grid", mode: "solo", category: "grids", columns: 2, rows: grid(2, 3, 4 / 3), shots: 6 },
  { id: "cut8", name: "Eight-cut", mode: "solo", category: "grids", columns: 2, rows: grid(2, 4, 3 / 2), shots: 8 },
  { id: "duo-grid", name: "Couple grid", mode: "duo", category: "grids", columns: 2, rows: grid(2, 2, 3 / 2, ["A", "B", "B", "A"]), shots: 2 },
  { id: "duo-film", name: "Two film rows", mode: "duo", category: "wide", columns: 4, rows: (["A", "B"] as const).map(role => ({ aspect: 3 / 4, cells: [0, 1, 2, 3].map(shot => cellOf(role, shot)) })), shots: 4 },
  // 9:4 and 3:1 rows give each person a 3:4 slice, like Side by side
  { id: "trio-split", name: "Trio side by side", mode: "group", category: "together", columns: 2, rows: splitRows(["A", "B", "C"], 9 / 4, 4), shots: 4, minMembers: 3 },
  { id: "quad-split", name: "Quad side by side", mode: "group", category: "together", columns: 2, rows: splitRows(["A", "B", "C", "D"], 3, 4), shots: 4, minMembers: 4 },
  { id: "trio-row", name: "Trio row", mode: "group", category: "wide", columns: 3, rows: grid(3, 1, 3 / 4, ["A", "B", "C"]), shots: 1, minMembers: 3 },
  { id: "quad-grid", name: "Quad grid", mode: "group", category: "grids", columns: 2, rows: [{ aspect: 4 / 3, cells: [cellOf("A", 0), cellOf("B", 0)] }, { aspect: 4 / 3, cells: [cellOf("C", 0), cellOf("D", 0)] }], shots: 1, minMembers: 4 },
];

export function getLayout(id: string): StripLayout {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

const geometryCache = new WeakMap<StripLayout, Map<string, StripGeometry>>();

/** Film holes, 20 across and 14 along at a 36-unit pitch, centred in the margin of both long edges. */
export function sprocketHoles(width: number, height: number, edge: number, vertical: boolean): Rect[] {
  const length = vertical ? height : width, pitch = 36, along = 14, across = 20;
  const count = Math.max(0, Math.floor((length - along - 16) / pitch) + 1), start = (length - (count - 1) * pitch - along) / 2;
  const near = (edge - across) / 2, far = (vertical ? width : height) - edge + near;
  return [near, far].flatMap(position => Array.from({ length: count }, (_, i) => vertical
    ? { x: position, y: start + i * pitch, width: across, height: along }
    : { x: start + i * pitch, y: position, width: along, height: across }));
}

export function stripGeometry(layout: StripLayout, strip?: Partial<StripOptions> | null): StripGeometry {
  const options = resolveStrip(strip), key = `${options.spacing}|${options.band}|${options.footer}|${options.sprockets}`;
  let byOptions = geometryCache.get(layout);
  if (!byOptions) geometryCache.set(layout, byOptions = new Map());
  const cached = byOptions.get(key);
  if (cached) return cached;
  const { margin, gap } = SPACING[options.spacing], footer = FOOTER_HEIGHT[options.footer];
  const contentWidth = layout.columns * CELL_W + (layout.columns - 1) * gap;
  // whole units keep template canvases integral
  const rowHeights = layout.rows.map(row => Math.round((contentWidth - (row.cells.length - 1) * gap) / row.cells.length / row.aspect));
  const contentHeight = rowHeights.reduce((sum, height) => sum + height, 0) + (layout.rows.length - 1) * gap;
  const vertical = contentHeight + footer >= contentWidth;
  const marginX = options.sprockets && vertical ? Math.max(margin, SPROCKET_MARGIN) : margin;
  const marginY = options.sprockets && !vertical ? Math.max(margin, SPROCKET_MARGIN) : margin;
  const width = contentWidth + marginX * 2, height = contentHeight + footer + marginY * 2;
  const cells: CellRect[] = [];
  let y = options.band === "top" ? marginY + footer : marginY;
  layout.rows.forEach((row, rowIndex) => {
    const count = row.cells.length, cellWidth = (contentWidth - (count - 1) * gap) / count, cellHeight = rowHeights[rowIndex];
    row.cells.forEach((cell, col) => cells.push({ index: cells.length, x: marginX + col * (cellWidth + gap), y, width: cellWidth, height: cellHeight, owners: cell.owners, shot: cell.shot, aspect: cellWidth / cellHeight }));
    y += cellHeight + gap;
  });
  const band = { x: marginX, y: options.band === "top" ? marginY : marginY + contentHeight, width: contentWidth, height: footer };
  const geometry: StripGeometry = { width, height, margin: marginX, gap, cells, band, sprockets: options.sprockets ? sprocketHoles(width, height, vertical ? marginX : marginY, vertical) : [] };
  byOptions.set(key, geometry);
  return geometry;
}

/** Caption band of a template canvas, which has no layout margins of its own. */
export function canvasBand(width: number, height: number, strip?: Partial<StripOptions> | null): Rect {
  const options = resolveStrip(strip), footer = FOOTER_HEIGHT[options.footer];
  return { x: STRIP_MARGIN, y: options.band === "top" ? STRIP_MARGIN : height - STRIP_MARGIN - footer, width: width - STRIP_MARGIN * 2, height: footer };
}

export function layoutCells(layout: StripLayout): readonly CellRect[] {
  return stripGeometry(layout).cells;
}

export function layoutCellCount(layout: StripLayout): number {
  return layout.rows.reduce((sum, row) => sum + row.cells.length, 0);
}

/** Roles that own at least one cell. */
export function layoutRoles(layout: StripLayout): ReadonlySet<Role> {
  return new Set(layout.rows.flatMap(row => row.cells.flatMap(cell => cell.owners)));
}

/** Which shot a cell displays. */
export function cellShotIndex(layout: StripLayout, cellIndex: number): number {
  return layoutCells(layout)[cellIndex]?.shot ?? 0;
}

/** Source slice for one part of a split cell. Two-way splits keep the V2 centre half; wider splits cover-crop the whole photo. */
export function splitSlice(parts: number): [number, number] {
  return parts === 2 ? [0.25, 0.75] : [0, 1];
}

/** Aspect of the first cell that shows the given shot, for capture framing. */
export function shotAspect(layout: StripLayout, shot: number): number {
  const cell = layoutCells(layout).find(item => item.shot === shot) ?? layoutCells(layout)[0];
  return cell.aspect / cell.owners.length;
}

/** Layouts available to a legacy shared room of the given size. */
export function layoutsForMembers(count: number): StripLayout[] {
  const legacy = LAYOUTS.filter(l => l.legacy);
  if (count >= 3) {
    return legacy.filter((l) => l.mode === "group" && (l.minMembers ?? 0) <= count);
  }
  return legacy.filter((l) => l.mode === "duo");
}

export function stripSize(layout: StripLayout, strip?: Partial<StripOptions> | null): { width: number; height: number } {
  const { width, height } = stripGeometry(layout, strip);
  return { width, height };
}
