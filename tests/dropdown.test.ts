import assert from "node:assert/strict";
import test from "node:test";
import { dropdownMatch, dropdownPlacement, dropdownPortalRoot, dropdownStep, dropdownUsesPopover, type DropdownOption } from "../lib/dropdown";

test("fallback rehearsal cannot override production capability detection", () => {
  assert.equal(dropdownUsesPopover(true, true, "development"), false);
  assert.equal(dropdownUsesPopover(true, false, "development"), true);
  for (const environment of ["production", "test", undefined]) assert.equal(dropdownUsesPopover(true, true, environment), true);
  assert.equal(dropdownUsesPopover(false, false, "production"), false);
});

test("fallback popup stays inside an open modal dialog instead of its inert page siblings", () => {
  const body = { nodeName: "BODY" } as Element, dialog = { nodeName: "DIALOG" } as Element;
  assert.equal(dropdownPortalRoot({ closest: selector => { assert.equal(selector, "dialog[open]"); return dialog; } }, body), dialog);
  assert.equal(dropdownPortalRoot({ closest: () => null }, body), body);
  assert.equal(dropdownPortalRoot(null, body), body);
});

const options: DropdownOption[] = [
  { value: "classic", label: "Classic" },
  { value: "missing", label: "Camera unavailable", disabled: true },
  { value: "camera", label: "Camera two" },
  { value: "flexible", label: "Flexible" },
  { value: "summer", label: "Été" },
];

test("dropdown arrows and Home/End skip disabled options and stop at the available boundaries", () => {
  assert.equal(dropdownStep(options, 0, 1), 2);
  assert.equal(dropdownStep(options, 2, -1), 0);
  assert.equal(dropdownStep(options, 4, 1), 4);
  assert.equal(dropdownStep(options, 0, -1), 0);
  assert.equal(dropdownStep(options, -1, "first"), 0);
  assert.equal(dropdownStep(options, 0, "last"), 4);
  assert.equal(dropdownStep(options, -1, -1), 4);
  assert.equal(dropdownStep([], -1, 1), -1);
  assert.equal(dropdownStep([{ value: "a", label: "Unavailable", disabled: true }], 0, "first"), -1);
});

test("typeahead cycles matching enabled labels, refines a prefix and folds accents", () => {
  assert.equal(dropdownMatch(options, "c", 0), 2);
  assert.equal(dropdownMatch(options, "c", 2), 0);
  assert.equal(dropdownMatch(options, "ca", 2, true), 2);
  assert.equal(dropdownMatch(options, "flex", -1), 3);
  assert.equal(dropdownMatch(options, "ete", 0), 4);
  assert.equal(dropdownMatch(options, "unmatched", 3), 3);
  assert.equal(dropdownMatch([], "x", -1), -1);
});

test("popup placement uses available room above or below and stays inside mobile viewport", () => {
  const below = dropdownPlacement({ left: 20, top: 30, bottom: 74, width: 120 }, { width: 390, height: 700 }, 240);
  assert.equal(below.top, 80);
  assert.equal(below.maxHeight, 240);
  const above = dropdownPlacement({ left: 270, top: 600, bottom: 644, width: 120 }, { width: 390, height: 700 }, 500);
  assert(above.top < 600);
  assert.equal(above.maxHeight, 320);
  assert(above.left + above.width <= 382);
  const narrow = dropdownPlacement({ left: -10, top: 100, bottom: 144, width: 900 }, { width: 320, height: 260 }, 800);
  assert.equal(narrow.width, 304);
  assert(narrow.left >= 8 && narrow.top >= 8);
  assert(narrow.top + narrow.maxHeight <= 252);
});

test("paged keyboard navigation advances through enabled choices and clamps at each end", () => {
  const choices = Array.from({ length: 32 }, (_, index) => ({ value: String(index), label: `Choice ${index}`, disabled: index % 5 === 4 }));
  assert.equal(dropdownStep(choices, 0, 1, 10), 12);
  assert.equal(dropdownStep(choices, 12, -1, 10), 0);
  assert.equal(dropdownStep(choices, 30, 1, 10), 31);
  assert.equal(dropdownStep(choices, 1, -1, 10), 0);
  assert.equal(dropdownStep(choices, 0, 1, Infinity), 1);
});

test("pinch-zoom and panned visual viewports bound the popup in layout coordinates", () => {
  const viewport = { left: 120, top: 260, width: 195, height: 310 };
  const result = dropdownPlacement({ left: 260, top: 460, bottom: 504, width: 260 }, viewport, 800);
  assert.equal(result.width, 179);
  assert(result.left >= 128 && result.left + result.width <= 307);
  assert(result.top >= 268 && result.top + result.maxHeight <= 562);
  assert(result.top < 460);
  const shifted = dropdownPlacement({ left: 260, top: 460, bottom: 504, width: 260 }, { ...viewport, left: 180, top: 400 }, 800);
  assert(shifted.left >= 188 && shifted.left + shifted.width <= 367);
  assert(shifted.top >= 408 && shifted.top + shifted.maxHeight <= 702);
});
