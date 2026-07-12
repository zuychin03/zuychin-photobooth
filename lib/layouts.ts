// Strip geometry is defined in abstract units (cell width = 480) and
// scaled at compose time; preview and export share the same math.
export const CELL_W = 480;
export const STRIP_MARGIN = 28;
export const CELL_GAP = 18;
export const FOOTER_H = 132;

/** Host is A; guests get B, C, D in join order. */
export type Role = "A" | "B" | "C" | "D";

export const ROLES: Role[] = ["A", "B", "C", "D"];

export type CellOwner = Role | "AB";

export interface StripLayout {
  id: string;
  name: string;
  mode: "solo" | "duo" | "group";
  cols: number;
  rows: number;
  /** width / height of each photo cell */
  cellAspect: number;
  /** shots each participant takes (synced fires in duo/group mode) */
  shots: number;
  /** minimum participants this layout makes sense for */
  minMembers?: number;
  /**
   * Shared rooms only, row-major: which member's frame fills each cell.
   * Each row is one synced fire; "AB" splits the cell into left (A) and
   * right (B) halves of the same shot.
   */
  duoPattern?: CellOwner[];
}

export const LAYOUTS: StripLayout[] = [
  {
    id: "strip4",
    name: "Classic strip",
    mode: "solo",
    cols: 1,
    rows: 4,
    cellAspect: 3 / 2,
    shots: 4,
  },
  {
    id: "grid4",
    name: "2×2 grid",
    mode: "solo",
    cols: 2,
    rows: 2,
    cellAspect: 4 / 3,
    shots: 4,
  },
  {
    id: "strip3",
    name: "Tall three",
    mode: "solo",
    cols: 1,
    rows: 3,
    cellAspect: 4 / 3,
    shots: 3,
  },
  {
    id: "duo-alternate",
    name: "Taking turns",
    mode: "duo",
    cols: 1,
    rows: 4,
    cellAspect: 3 / 2,
    shots: 4,
    duoPattern: ["A", "B", "A", "B"],
  },
  {
    id: "duo-split",
    name: "Side by side",
    mode: "duo",
    cols: 1,
    rows: 4,
    cellAspect: 3 / 2,
    shots: 4,
    duoPattern: ["AB", "AB", "AB", "AB"],
  },
  {
    id: "duo-twin",
    name: "Twin strips",
    mode: "duo",
    cols: 2,
    rows: 4,
    cellAspect: 3 / 2,
    shots: 4,
    duoPattern: ["A", "B", "A", "B", "A", "B", "A", "B"],
  },
  {
    id: "trio",
    name: "Trio strips",
    mode: "group",
    cols: 3,
    rows: 4,
    cellAspect: 3 / 2,
    shots: 4,
    minMembers: 3,
    duoPattern: ["A", "B", "C", "A", "B", "C", "A", "B", "C", "A", "B", "C"],
  },
  {
    id: "quad",
    name: "Quad strips",
    mode: "group",
    cols: 4,
    rows: 3,
    cellAspect: 3 / 2,
    shots: 3,
    minMembers: 4,
    duoPattern: ["A", "B", "C", "D", "A", "B", "C", "D", "A", "B", "C", "D"],
  },
];

export function getLayout(id: string): StripLayout {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

/** Which shot a cell displays: shared-room rows are one synced fire each; solo cells map 1:1. */
export function cellShotIndex(layout: StripLayout, cellIndex: number): number {
  return layout.mode === "solo" ? cellIndex : Math.floor(cellIndex / layout.cols);
}

/** Layouts available to a shared room of the given size. */
export function layoutsForMembers(count: number): StripLayout[] {
  if (count >= 3) {
    return LAYOUTS.filter((l) => l.mode === "group" && (l.minMembers ?? 0) <= count);
  }
  return LAYOUTS.filter((l) => l.mode === "duo");
}

export function stripSize(layout: StripLayout): { width: number; height: number } {
  const cellH = CELL_W / layout.cellAspect;
  const width = STRIP_MARGIN * 2 + layout.cols * CELL_W + (layout.cols - 1) * CELL_GAP;
  const height =
    STRIP_MARGIN * 2 + layout.rows * cellH + (layout.rows - 1) * CELL_GAP + FOOTER_H;
  return { width, height };
}
