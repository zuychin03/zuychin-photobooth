import assert from "node:assert/strict";
import { test } from "node:test";
import { composeStrip, type ComposeInput, type ShotSet } from "../lib/compose";
import { FRAMES } from "../lib/decor";
import { getLayout, stripGeometry, type Role } from "../lib/layouts";
import { applyProjectEdit, applyTemplateToProject, createProject, editorNeedsV5, validatePhotoProject } from "../lib/projects/model";
import { recipeSchemaFor, validateRecipeProposal, type RecipeEdit } from "../lib/rtc/recipe-v2";
import { DEFAULT_STRIP, formatStripDate, isStripDay, storedStrip, stripDateSource, stripDay, validateStripOptions, withStrip, type StripOptions } from "../lib/strip-style";
import { templateFromProject } from "../lib/templates/from-project";
import { templateSchemaFor, validateTemplateDesign, validateTemplateRecipe } from "../lib/templates/model";
import { immutableSource, installCanvasEnvironment, RecordingCanvas } from "./helpers/recording-canvas";

const createdAt = "2026-11-11T00:00:00.000Z", later = "2026-11-11T00:05:00.000Z";
const strip = (patch: Partial<StripOptions>): StripOptions => ({ ...DEFAULT_STRIP, ...patch });
const createRecipeProposal = (edit: RecipeEdit, baseRevision: number, schemaVersion: 1 | 2) => ({ schemaVersion, id: "10000000-0000-4000-8000-0000000000aa", baseRevision, edit });

function inputFor(layoutId: string, patch: Partial<ComposeInput> = {}): ComposeInput {
  const shots: ShotSet = {};
  for (const role of ["A", "B"] as Role[]) shots[role] = Array.from({ length: 8 }, () => immutableSource(1200, 800));
  return { layout: getLayout(layoutId), shots, style: { frameColor: "#ffffff", inkColor: "#111111", patternId: "none", filterId: "none", caption: "Hello", showDate: true, stickerStyle: "flat" }, stickers: [], capturedAt: "2026-11-11T03:00:00.000Z", captureTimeZone: "UTC", ...patch };
}

function render(t: Parameters<typeof installCanvasEnvironment>[0], input: ComposeInput) {
  installCanvasEnvironment(t);
  const target = new RecordingCanvas();
  composeStrip(target.element, input);
  return target;
}

test("strip options validate strictly and default looks are stored by omission", () => {
  assert.deepEqual(validateStripOptions({ ...DEFAULT_STRIP }), DEFAULT_STRIP);
  assert.throws(() => validateStripOptions({ ...DEFAULT_STRIP, finish: "glossy" }), /finish/);
  assert.throws(() => validateStripOptions({ ...DEFAULT_STRIP, extra: true }), /Unexpected/);
  assert.throws(() => validateStripOptions({ ...DEFAULT_STRIP, sprockets: "yes" }), /sprockets/);
  assert.equal(storedStrip(DEFAULT_STRIP), undefined);
  assert.deepEqual(storedStrip(strip({ finish: "rounded" })), strip({ finish: "rounded" }));
  const look: { frameId: string; strip?: StripOptions } = { frameId: "film", strip: strip({ band: "top" }) };
  assert.deepEqual(withStrip(look, DEFAULT_STRIP), { frameId: "film" });
  assert.deepEqual(withStrip({ frameId: "film" } as typeof look, strip({ band: "top" })), look);
});

test("date formats follow the capture time zone", () => {
  assert.equal(formatStripDate("2026-11-11T03:00:00.000Z", "UTC", "dots"), "11·11·2026");
  assert.equal(formatStripDate("2026-11-11T03:00:00.000Z", "UTC", "film"), "'26 11 11");
  assert.equal(formatStripDate("2026-11-11T03:00:00.000Z", "UTC", "long"), "11 Nov 2026");
  assert.equal(formatStripDate("2026-11-11T15:00:00.000Z", "Australia/Sydney", "dots"), "12·11·2026");
});

test("spacing, band position, footer and sprockets reshape the strip geometry", () => {
  const strip4 = getLayout("strip4");
  assert.deepEqual([stripGeometry(strip4).width, stripGeometry(strip4).height], [536, 1522]);
  assert.deepEqual([stripGeometry(strip4, strip({ spacing: "tight" })).width, stripGeometry(strip4, strip({ spacing: "tight" })).height], [512, 1468]);
  assert.deepEqual([stripGeometry(strip4, strip({ spacing: "airy" })).width, stripGeometry(strip4, strip({ spacing: "airy" })).height], [568, 1590]);
  const top = stripGeometry(strip4, strip({ band: "top" }));
  assert.equal(top.height, 1522); assert.equal(top.band.y, 28); assert.equal(top.cells[0].y, 160);
  const inline = stripGeometry(strip4, strip({ footer: "inline" }));
  assert.equal(inline.height, 1474); assert.equal(inline.band.height, 84);
  const film = stripGeometry(strip4, strip({ sprockets: true }));
  assert.deepEqual([film.width, film.height, film.cells[0].x], [560, 1522, 40]);
  assert(film.sprockets.length > 0 && film.sprockets.every(hole => (hole.x === 10 || hole.x === 530) && hole.width === 20 && hole.height === 14 && hole.y >= 0 && hole.y + hole.height <= 1522));
  const wide = stripGeometry(getLayout("film4"), strip({ sprockets: true }));
  assert.deepEqual([wide.width, wide.height, wide.cells[0].y], [2030, 852, 40]);
  assert(wide.sprockets.every(hole => (hole.y === 10 || hole.y === 822) && hole.width === 14 && hole.height === 20));
  for (const geometry of [film, wide]) for (const hole of geometry.sprockets) for (const cell of geometry.cells) {
    assert(hole.x + hole.width <= cell.x || cell.x + cell.width <= hole.x || hole.y + hole.height <= cell.y || cell.y + cell.height <= hole.y, "holes stay out of photos");
  }
  assert.equal(stripGeometry(strip4, null), stripGeometry(strip4, DEFAULT_STRIP));
});

test("the default strip composes exactly like no strip at all", (t) => {
  const base = inputFor("feature4"), plain = render(t, base), defaulted = render(t, { ...base, strip: DEFAULT_STRIP });
  assert.deepEqual([defaulted.width, defaulted.height], [plain.width, plain.height]);
  for (const key of ["draws", "fills", "texts", "textDraws", "rounded", "strokes", "shadowFills", "pathFills"] as const) assert.deepEqual(defaulted.context[key], plain.context[key], key);
  assert.equal(plain.context.rounded.length + plain.context.strokes.length + plain.context.shadowFills.length, 0);
});

test("finishes round, outline or lift every photo", (t) => {
  const cells = stripGeometry(getLayout("square4")).cells;
  const rounded = render(t, inputFor("square4", { strip: strip({ finish: "rounded" }) }));
  assert.deepEqual(rounded.context.rounded.map(item => item.rect), cells.map(cell => [cell.x, cell.y, cell.width, cell.height]));
  assert(rounded.context.rounded.every(item => item.radius === 480 * 0.06));
  assert(rounded.context.draws.every((draw, index) => draw.clip?.[0] === cells[index].x));
  const keyline = render(t, inputFor("square4", { strip: strip({ finish: "keyline" }) }));
  assert.deepEqual(keyline.context.strokes.map(item => item.coordinates), cells.map(cell => [cell.x - 5, cell.y - 5, cell.width + 10, cell.height + 10]));
  assert(keyline.context.strokes.every(item => item.strokeStyle === "#111111" && item.lineWidth === 2));
  const tight = render(t, inputFor("square4", { strip: strip({ finish: "keyline", spacing: "tight" }) }));
  assert.deepEqual(tight.context.strokes[0].coordinates.slice(0, 2), [16 - 3, 16 - 3]);
  const lifted = render(t, inputFor("square4", { strip: strip({ finish: "lifted" }) }));
  assert.deepEqual(lifted.context.shadowFills.map(item => item.coordinates), cells.map(cell => [cell.x, cell.y, cell.width, cell.height]));
  assert.equal(lifted.context.draws.length, 4);
});

test("film edges punch every sprocket hole in the frame ink", (t) => {
  const geometry = stripGeometry(getLayout("strip4"), strip({ sprockets: true }));
  const target = render(t, inputFor("strip4", { strip: strip({ sprockets: true }) }));
  assert.deepEqual([target.width, target.height], [geometry.width, geometry.height]);
  assert.deepEqual(target.context.pathFills.map(fill => fill.rect), geometry.sprockets.map(hole => [hole.x, hole.y, hole.width, hole.height]));
  assert(target.context.pathFills.every(fill => fill.fillStyle === "#111111" && fill.alpha === 0.85));
  assert(target.context.rounded.every(item => item.radius === 3));
});

test("caption band, footer, date placement, font and format each change the text drawing", (t) => {
  const geometry = stripGeometry(getLayout("strip4"));
  const caption = (target: RecordingCanvas) => target.context.textDraws.find(item => item.text === "Hello")!;
  const date = (target: RecordingCanvas) => target.context.textDraws.find(item => item.text !== "Hello")!;
  const plain = render(t, inputFor("strip4"));
  assert.deepEqual([caption(plain).x, caption(plain).y, caption(plain).align], [268, geometry.band.y + 132 * 0.42, "center"]);
  assert.equal(date(plain).text, "11·11·2026");
  assert.match(caption(plain).font, /^600 34px Georgia, serif$/);
  const top = render(t, inputFor("strip4", { strip: strip({ band: "top" }) }));
  assert.equal(caption(top).y, 28 + 132 * 0.42);
  const inline = render(t, inputFor("strip4", { strip: strip({ footer: "inline" }) })), band = stripGeometry(getLayout("strip4"), strip({ footer: "inline" })).band;
  assert.deepEqual([caption(inline).x, caption(inline).y, caption(inline).align], [band.x, band.y + 42, "left"]);
  assert.deepEqual([date(inline).x, date(inline).y, date(inline).align], [band.x + band.width, band.y + 42, "right"]);
  const onPhoto = render(t, inputFor("strip4", { strip: strip({ date: "photo", dateFormat: "long" }) })), last = geometry.cells.at(-1)!, size = last.height * 0.08;
  assert.equal(date(onPhoto).text, "11 Nov 2026");
  assert.deepEqual([date(onPhoto).x, date(onPhoto).y, date(onPhoto).align], [last.x + last.width - size * 0.6, last.y + last.height - size * 0.9, "right"]);
  assert.match(date(onPhoto).font, new RegExp(`^italic 700 ${size}px monospace$`));
  assert.match(caption(render(t, inputFor("strip4", { strip: strip({ font: "mono" }) }))).font, /monospace$/);
  assert.match(caption(render(t, inputFor("strip4", { strip: strip({ font: "sans" }) }))).font, /sans-serif$/);
  assert.equal(date(render(t, inputFor("strip4", { strip: strip({ dateFormat: "film" }) }))).text, "'26 11 11");
});

test("gradient frames paint top-left to bottom-right", (t) => {
  installCanvasEnvironment(t);
  const target = new RecordingCanvas(), calls: number[][] = [], stops: [number, string][] = [];
  target.context.createLinearGradient = ((...args: number[]) => { calls.push(args); return { addColorStop: (offset: number, colour: string) => { stops.push([offset, colour]); } }; }) as typeof target.context.createLinearGradient;
  const peach = FRAMES.find(frame => frame.id === "peach")!;
  composeStrip(target.element, inputFor("strip4", { style: { ...inputFor("strip4").style, frameColor: peach.color, frameGradient: peach.gradient } }));
  assert.deepEqual(calls, [[0, 0, 536, 1522]]);
  assert.deepEqual(stops, [[0, "#fecaca"], [1, "#fde68a"]]);
});

test("strip styles and V3 frames need project schema 5, template v2 and recipe v2", () => {
  const legacy = createProject({ createdAt, captureTimeZone: "UTC" });
  const styled = applyProjectEdit(legacy, { sourceOrder: legacy.sourceOrder, editor: { ...legacy.editor, strip: strip({ finish: "rounded" }) } }, later);
  assert.equal(styled.schemaVersion, 5); assert.equal(styled.editor.strip?.finish, "rounded");
  assert.throws(() => validatePhotoProject({ ...styled, schemaVersion: 4 }), /editor/);
  const reset = applyProjectEdit(styled, { sourceOrder: styled.sourceOrder, editor: { ...styled.editor, strip: undefined } }, later);
  assert.equal(reset.editor.strip, undefined); assert(!("strip" in reset.editor));
  const defaulted = applyProjectEdit(legacy, { sourceOrder: legacy.sourceOrder, editor: { ...legacy.editor, strip: DEFAULT_STRIP } }, later);
  assert.equal(defaulted.schemaVersion, 4); assert(!("strip" in defaulted.editor));
  const cherry = applyProjectEdit(legacy, { sourceOrder: legacy.sourceOrder, editor: { ...legacy.editor, frameId: "cherry" } }, later);
  assert.equal(cherry.schemaVersion, 5);
  assert.throws(() => validatePhotoProject({ ...cherry, schemaVersion: 4 }), /frameId|editor/);
  assert(editorNeedsV5({ frameId: "seaglass" }) && !editorNeedsV5({ frameId: "lavender" }) && !editorNeedsV5({ strip: DEFAULT_STRIP }));

  const design = templateFromProject(styled);
  assert.deepEqual(design.look.strip, strip({ finish: "rounded" }));
  assert.equal(templateSchemaFor(design), 2);
  assert.equal(templateSchemaFor({ ...design, look: { ...design.look, strip: undefined, frameId: "midnight" } }), 2);
  const recipe = { ...design, id: "styled", name: "Styled", revision: 0, scope: { kind: "device" }, createdAt, updatedAt: createdAt };
  assert.throws(() => validateTemplateRecipe({ ...recipe, schemaVersion: 1 }), /look/);
  assert.equal(validateTemplateRecipe({ ...recipe, schemaVersion: 2 }).look.strip?.finish, "rounded");
  const applied = applyTemplateToProject(createProject({ createdAt, captureTimeZone: "UTC", editor: { strip: strip({ band: "top" }) } }), design, [], later);
  assert.deepEqual(applied.editor.strip, strip({ finish: "rounded" }));
  const plainDesign = validateTemplateDesign(templateFromProject(legacy));
  const cleared = applyTemplateToProject(styled, plainDesign, [], later);
  assert.equal(cleared.editor.strip, undefined);

  assert.equal(recipeSchemaFor({ strip: strip({ sprockets: true }) }), 2);
  assert.equal(recipeSchemaFor({ strip: DEFAULT_STRIP }), 1);
  const proposal = createRecipeProposal({ kind: "shared", patch: { strip: strip({ date: "photo" }) } }, 0, recipeSchemaFor({ strip: strip({ date: "photo" }) }));
  assert.equal(validateRecipeProposal(proposal).schemaVersion, 2);
  assert.throws(() => validateRecipeProposal({ ...proposal, schemaVersion: 1 }));
  assert.equal(validateRecipeProposal(createRecipeProposal({ kind: "shared", patch: { strip: DEFAULT_STRIP } }, 0, 1)).schemaVersion, 1);
});

test("a chosen strip date prints instead of the capture date and needs project schema 5", (t) => {
  assert(isStripDay("2024-02-29") && !isStripDay("2023-02-29") && !isStripDay("2026-1-01") && !isStripDay("1899-12-31") && !isStripDay(20240229));
  assert.equal(stripDay("2026-11-11T15:00:00.000Z", "Australia/Sydney"), "2026-11-12");
  assert.equal(stripDay("2026-11-11T15:00:00.000Z", "UTC"), "2026-11-11");
  assert.deepEqual(stripDateSource(undefined, "2026-11-11T15:00:00.000Z", "Australia/Sydney"), { capturedAt: "2026-11-11T15:00:00.000Z", captureTimeZone: "Australia/Sydney" });
  const date = (target: RecordingCanvas) => target.context.textDraws.find(item => item.text !== "Hello")!;
  const chosen = stripDateSource("2024-02-29", "2026-11-11T15:00:00.000Z", "Pacific/Kiritimati");
  assert.equal(date(render(t, inputFor("strip4", { ...chosen, strip: strip({ dateFormat: "long" }) }))).text, "29 Feb 2024");
  assert.equal(date(render(t, inputFor("strip4", stripDateSource("2024-02-29", null, "UTC")))).text, "29·02·2024");

  const legacy = createProject({ createdAt, captureTimeZone: "UTC" });
  const dated = applyProjectEdit(legacy, { sourceOrder: legacy.sourceOrder, editor: { ...legacy.editor, stripDate: "2024-02-29" } }, later);
  assert.equal(dated.schemaVersion, 5); assert.equal(dated.editor.stripDate, "2024-02-29");
  assert.throws(() => validatePhotoProject({ ...dated, schemaVersion: 4 }), /editor/);
  assert.throws(() => applyProjectEdit(dated, { sourceOrder: dated.sourceOrder, editor: { ...dated.editor, stripDate: "2024-02-30" } }, later), /stripDate/);
  const cleared = applyProjectEdit(dated, { sourceOrder: dated.sourceOrder, editor: { ...dated.editor, stripDate: undefined } }, later);
  assert(!("stripDate" in cleared.editor));
  assert.equal(applyProjectEdit(legacy, { sourceOrder: legacy.sourceOrder, editor: { ...legacy.editor, stripDate: undefined } }, later).schemaVersion, 4);
  assert(editorNeedsV5({ stripDate: "2024-02-29" }) && !editorNeedsV5({ stripDate: undefined }));
});
