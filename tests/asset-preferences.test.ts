import assert from "node:assert/strict";
import test from "node:test";
import { readAssetFavourites, writeAssetFavourites, validateAssetFavourites } from "../lib/assets/preferences";
import { CURATED_ASSETS } from "../lib/assets/registry";

test("favourites retain only known scene/material IDs and deduplicate within the complete library bound", () => {
  assert.deepEqual(validateAssetFavourites(["studio-cream", CURATED_ASSETS[0].id, "foreign", "https://remote.test", "studio-cream", 4]), ["studio-cream", CURATED_ASSETS[0].id]);
  assert.throws(() => validateAssetFavourites(Array(31).fill("studio-cream")));
  assert.throws(() => validateAssetFavourites({ ids: [] }));
});

test("favourites storage round-trips safely and malformed/future/unavailable storage stays empty", () => {
  let raw = "";
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  assert.equal(writeAssetFavourites([CURATED_ASSETS[1].id, "night"], storage), true);
  assert.deepEqual(readAssetFavourites(storage), [CURATED_ASSETS[1].id, "night"]);
  for (const input of ["{", JSON.stringify({ version: 2, ids: ["night"] }), "x".repeat(4097)]) { raw = input; assert.deepEqual(readAssetFavourites(storage), []); }
  const unavailable = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
  assert.deepEqual(readAssetFavourites(unavailable), []); assert.equal(writeAssetFavourites(["night"], unavailable), false);
});
