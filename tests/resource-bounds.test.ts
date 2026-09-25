import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDecodedImageDimensions,
  assertEncodedMediaMatches,
  parseResourceManifest,
  RESOURCE_LIMITS,
  ResourceValidationError,
  validateResourceManifest,
} from "../lib/projects/resource-bounds";

function fixture(participantCount = 1, shots = 1) {
  const participants = Array.from({ length: participantCount }, (_, role) => ({
    id: `person-${role}`,
    sourceIds: Array.from({ length: shots }, (_, shot) => `photo-${role}-${shot}`),
  }));
  return {
    version: 1,
    mode: participantCount === 1 ? "solo" : "shared",
    participants,
    media: participants.flatMap(person => person.sourceIds.map(id => ({
      id, kind: "photo", mime: "image/jpeg", bytes: 1024, width: 640, height: 480,
    }))),
    slots: [{ id: "slot-1", sourceIds: [participants[0].sourceIds[0]] }],
    textLayers: [] as { id: string; text: string }[],
    stickerLayers: [] as { id: string; asset: { kind: string; id: string } }[],
  };
}

function decoration(id = "frame") {
  return { id, kind: "decoration", mime: "image/png", bytes: 32, width: 32, height: 32 };
}

test("solo inventory parses into a detached immutable resource fragment", () => {
  const draft = fixture();
  const parsed = validateResourceManifest(draft);
  draft.participants[0].sourceIds[0] = "changed";
  draft.media[0].width = 1;
  assert.equal(parsed.participants[0].sourceIds[0], "photo-0-0");
  assert.equal(parsed.media[0].width, 640);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.media[0]));
  assert(Object.isFrozen(parsed.participants[0].sourceIds));
  assert.deepEqual(parseResourceManifest(JSON.stringify(fixture())), parsed);
});

test("four participants can declare four sources each and reuse them across sixteen slots", () => {
  const draft = fixture(4, 4);
  draft.slots = Array.from({ length: 16 }, (_, index) => ({
    id: `slot-${index}`, sourceIds: draft.participants.map(person => person.sourceIds[index % 4]),
  }));
  const parsed = validateResourceManifest(draft);
  assert.equal(parsed.media.length, 16);
  assert.equal(parsed.slots.length, 16);
  assert.equal(parsed.slots[0].sourceIds.length, 4);
});

test("participant modes enforce one solo participant or two to four shared participants", () => {
  for (const count of [0, 5]) {
    const draft = fixture();
    draft.participants = Array.from({ length: count }, () => draft.participants[0]);
    assert.throws(() => validateResourceManifest(draft), ResourceValidationError);
  }
  const solo = fixture(2);
  solo.mode = "solo";
  assert.throws(() => validateResourceManifest(solo), /participants/);
  const shared = fixture();
  shared.mode = "shared";
  assert.throws(() => validateResourceManifest(shared), /participants/);
});

test("each participant needs one to four unique sources with exclusive ownership", () => {
  const empty = fixture();
  empty.participants[0].sourceIds = [];
  assert.throws(() => validateResourceManifest(empty), /sourceIds/);
  assert.throws(() => validateResourceManifest(fixture(1, 5)), /sourceIds/);
  const repeated = fixture();
  repeated.participants[0].sourceIds.push(repeated.participants[0].sourceIds[0]);
  assert.throws(() => validateResourceManifest(repeated), /Duplicate identifier/);
  const shared = fixture(2);
  shared.participants[1].sourceIds = shared.participants[0].sourceIds;
  assert.throws(() => validateResourceManifest(shared), /Duplicate identifier/);
});

test("missing, unowned and non-photo sources are rejected", () => {
  const missing = fixture();
  missing.participants[0].sourceIds = ["missing"];
  assert.throws(() => validateResourceManifest(missing), /declared photo/);
  const unowned = fixture(1, 2);
  unowned.participants[0].sourceIds.pop();
  assert.throws(() => validateResourceManifest(unowned), /exactly one participant/);
  const nonPhoto = fixture();
  nonPhoto.media[0] = decoration(nonPhoto.media[0].id);
  assert.throws(() => validateResourceManifest(nonPhoto), /declared photo/);
  const missingSlot = fixture();
  missingSlot.slots[0].sourceIds = ["missing"];
  assert.throws(() => validateResourceManifest(missingSlot), /missing source/);
});

test("duplicate media, participant and cross-layer identifiers are rejected", () => {
  const media = fixture();
  media.media.push({ ...media.media[0] });
  assert.throws(() => validateResourceManifest(media), /Duplicate identifier/);
  const people = fixture(2);
  people.participants[1].id = people.participants[0].id;
  assert.throws(() => validateResourceManifest(people), /Duplicate identifier/);
  const layers = fixture();
  layers.textLayers.push({ id: layers.slots[0].id, text: "Hello" });
  assert.throws(() => validateResourceManifest(layers), /Duplicate identifier/);
});

test("slot counts and per-slot source counts are bounded", () => {
  for (const count of [0, 17]) {
    const draft = fixture();
    draft.slots = Array.from({ length: count }, (_, index) => ({ id: `slot-${index}`, sourceIds: ["photo-0-0"] }));
    assert.throws(() => validateResourceManifest(draft), /slots/);
  }
  const tooMany = fixture(2, 3);
  tooMany.slots[0].sourceIds = tooMany.media.slice(0, 5).map(item => item.id);
  assert.throws(() => validateResourceManifest(tooMany), /sourceIds/);
});

test("only JPEG, PNG and WebP still declarations are accepted", () => {
  for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
    const draft = fixture();
    draft.media[0].mime = mime;
    assert.equal(validateResourceManifest(draft).media[0].mime, mime);
  }
  for (const mime of ["image/svg+xml", "text/html", "image/gif", "image/avif", "image/heic", "video/mp4", "", "image/png;foo=bar"]) {
    const draft = fixture();
    draft.media[0].mime = mime;
    assert.throws(() => validateResourceManifest(draft), /mime/);
  }
});

test("decorations require PNG and remain within separate file and dimension limits", () => {
  const draft = fixture();
  const image = { ...decoration(), bytes: RESOURCE_LIMITS.decorationBytes, width: 2048, height: 2048 };
  draft.media.push(image);
  validateResourceManifest(draft);
  for (const change of [{ mime: "image/jpeg" }, { bytes: image.bytes + 1 }, { width: 2049 }]) {
    draft.media[1] = { ...image, ...change };
    assert.throws(() => validateResourceManifest(draft), ResourceValidationError);
  }
});

test("decoded dimensions reject non-finite, fractional, coerced and oversized values", () => {
  for (const value of [0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "640", null]) {
    for (const field of ["width", "height"]) {
      const draft = fixture();
      Object.assign(draft.media[0], { [field]: value });
      assert.throws(() => validateResourceManifest(draft), ResourceValidationError);
    }
  }
  const draft = fixture();
  Object.assign(draft.media[0], { width: 4096, height: 3072 });
  validateResourceManifest(draft);
  draft.media[0].height++;
  assert.throws(() => validateResourceManifest(draft), /pixel budget/);
  Object.assign(draft.media[0], { width: 4097, height: 1 });
  assert.throws(() => validateResourceManifest(draft), /width/);
});

test("aggregate decoded pixels reject many individually permitted images", () => {
  const draft = fixture(1, 4);
  draft.media.forEach(item => Object.assign(item, { width: 4096, height: 3072 }));
  validateResourceManifest(draft);
  draft.media.push({ ...decoration(), width: 1, height: 1 });
  assert.throws(() => validateResourceManifest(draft), /Total decoded pixel budget/);
});

test("file byte counts reject zero, fractional, coerced and oversized declarations", () => {
  const draft = fixture();
  draft.media[0].bytes = RESOURCE_LIMITS.photoBytes;
  validateResourceManifest(draft);
  for (const bytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1024", RESOURCE_LIMITS.photoBytes + 1]) {
    Object.assign(draft.media[0], { bytes });
    assert.throws(() => validateResourceManifest(draft), /bytes/);
  }
});

test("aggregate encoded bytes reject a set of individually permitted files", () => {
  const draft = fixture(2, 4);
  draft.media.forEach(item => { item.bytes = 8 * 1024 * 1024; });
  validateResourceManifest(draft);
  draft.media[0].bytes++;
  assert.throws(() => validateResourceManifest(draft), /Total encoded byte budget/);
});

test("twenty-four files fit only within the eight-decoration ceiling", () => {
  const draft = fixture(4, 4);
  draft.media.push(...Array.from({ length: 8 }, (_, index) => decoration(`deco-${index}`)));
  assert.equal(validateResourceManifest(draft).media.length, 24);
  draft.media.push(decoration("extra"));
  assert.throws(() => validateResourceManifest(draft), /media/);
  const tooManyDecorations = fixture();
  tooManyDecorations.media.push(...Array.from({ length: 9 }, (_, index) => decoration(`deco-${index}`)));
  assert.throws(() => validateResourceManifest(tooManyDecorations), /Decoration file budget/);
});

test("text limits count Unicode code points and retain Vietnamese and multiline text", () => {
  const draft = fixture();
  draft.textLayers = Array.from({ length: 16 }, (_, index) => ({ id: `text-${index}`, text: "📷".repeat(500) }));
  assert.equal(validateResourceManifest(draft).textLayers.length, 16);
  draft.textLayers[0].text = "Kỷ niệm của chúng mình\nSydney\t2026";
  assert.equal(validateResourceManifest(draft).textLayers[0].text, draft.textLayers[0].text);
  draft.textLayers[0].text = "📷".repeat(501);
  assert.throws(() => validateResourceManifest(draft), /code points/);
  draft.textLayers[0].text = "";
  draft.textLayers.push({ id: "extra-text", text: "" });
  assert.throws(() => validateResourceManifest(draft), /textLayers/);
});

test("captions preserve literal text while rejecting non-text control characters", () => {
  for (const text of ["<3", "a < b > c", "<script>alert(1)</script>"]) {
    const draft = fixture();
    draft.textLayers.push({ id: "text", text });
    assert.equal(validateResourceManifest(draft).textLayers[0].text, text);
  }
  for (const text of ["hello\u0000world", "hello\u0007", "hello\u007f"]) {
    const draft = fixture();
    draft.textLayers.push({ id: "text", text });
    assert.throws(() => validateResourceManifest(draft), /Non-text control/);
  }
});

test("sticker layers require trusted built-ins or declared local PNG decorations", () => {
  const draft = fixture();
  draft.media.push(decoration());
  draft.stickerLayers = Array.from({ length: 32 }, (_, index) => ({ id: `sticker-${index}`, asset: { kind: "media", id: "frame" } }));
  assert.equal(validateResourceManifest(draft).stickerLayers.length, 32);
  draft.stickerLayers[0].asset = { kind: "builtin", id: "heart" };
  assert.throws(() => validateResourceManifest(draft), /Unknown built-in/);
  validateResourceManifest(draft, new Set(["heart"]));
  draft.stickerLayers.push({ id: "extra-sticker", asset: { kind: "media", id: "frame" } });
  assert.throws(() => validateResourceManifest(draft, new Set(["heart"])), /stickerLayers/);
  draft.stickerLayers = [{ id: "sticker", asset: { kind: "media", id: "photo-0-0" } }];
  assert.throws(() => validateResourceManifest(draft), /declared PNG decoration/);
});

test("URL, path and markup identifiers cannot become media or sticker references", () => {
  for (const id of ["https://example.com/x.png", "//example.com/x", "data:image/png;base64,x", "blob:example", "../image", "<svg>", "", "x".repeat(65)]) {
    const draft = fixture();
    draft.media[0].id = id;
    assert.throws(() => validateResourceManifest(draft), /identifier/);
  }
  const draft = fixture();
  draft.stickerLayers.push({ id: "sticker", asset: { kind: "builtin", id: "https://example.com/asset" } });
  assert.throws(() => validateResourceManifest(draft, new Set(["https://example.com/asset"])), /identifier/);
});

test("unknown URL, HTML and prototype fields are rejected instead of silently retained", () => {
  for (const field of ["url", "html", "__proto__", "constructor"]) {
    const draft = fixture();
    Object.defineProperty(draft, field, { value: "untrusted", enumerable: true });
    assert.throws(() => validateResourceManifest(draft), /Unexpected or missing fields/);
  }
  const draft = fixture();
  Object.assign(draft.media[0], { url: "https://example.com/photo" });
  assert.throws(() => validateResourceManifest(draft), /Unexpected or missing fields/);
});

test("accessors, class instances and sparse arrays are not accepted as JSON data", () => {
  let getterCalled = false;
  const accessor = fixture();
  Object.defineProperty(accessor, "media", { get() { getterCalled = true; return []; } });
  assert.throws(() => validateResourceManifest(accessor), /Accessors/);
  assert.equal(getterCalled, false);
  assert.throws(() => validateResourceManifest(new Date()), /plain object/);
  const sparse = fixture();
  sparse.slots = Array(2);
  assert.throws(() => validateResourceManifest(sparse), /Sparse arrays/);
});

test("JSON parsing rejects byte overflow, malformed input and unknown versions", () => {
  assert.throws(() => parseResourceManifest(" ".repeat(RESOURCE_LIMITS.manifestBytes + 1)), /UTF-8 byte limit/);
  const multibyte = JSON.stringify({ text: "📷".repeat(16_384) });
  assert(multibyte.length < RESOURCE_LIMITS.manifestBytes);
  assert.throws(() => parseResourceManifest(multibyte), /UTF-8 byte limit/);
  assert.throws(() => parseResourceManifest("{broken"), /Invalid JSON/);
  const draft = fixture();
  draft.version = 2;
  assert.throws(() => parseResourceManifest(JSON.stringify(draft)), /Unsupported resource version/);
});

test("Blob binding validates actual size and MIME but does not claim to decode bytes", () => {
  const draft = fixture();
  draft.media[0].bytes = 1;
  const declaration = validateResourceManifest(draft).media[0];
  assertEncodedMediaMatches(new Blob(["x"], { type: "image/jpeg" }), declaration);
  assert.throws(() => assertEncodedMediaMatches(new Blob(["xx"], { type: "image/jpeg" }), declaration), /byte length or MIME/);
  assert.throws(() => assertEncodedMediaMatches(new Blob(["x"], { type: "image/svg+xml" }), declaration), /byte length or MIME/);
  assert.throws(() => assertEncodedMediaMatches({ size: 1, type: "image/jpeg" }, declaration), /byte length or MIME/);
});

test("decoded dimensions must match the bounded declaration exactly", () => {
  const declaration = validateResourceManifest(fixture()).media[0];
  assertDecodedImageDimensions(640, 480, declaration);
  for (const width of [640.5, 1280, Number.NaN, Number.POSITIVE_INFINITY, "640", undefined]) {
    assert.throws(() => assertDecodedImageDimensions(width, 480, declaration), /Decoded dimensions/);
  }
  assert.throws(() => assertDecodedImageDimensions(480, 640, declaration), /Decoded dimensions/);
});
