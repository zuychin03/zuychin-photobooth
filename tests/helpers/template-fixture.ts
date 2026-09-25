import { validateTemplateRecipe, type TemplateRecipe } from "../../lib/templates/model";
import { inspectImageHeader } from "../../lib/projects/images";

export const templateTimestamp = "2026-09-23T00:00:00.000Z";
export const inspectTemplateFixture = async (blob: Blob) => inspectImageHeader(new Uint8Array(await blob.arrayBuffer()));
export const templatePixel = () => new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64")], { type: "image/png" });
export function templateFixture(withDecoration = false): TemplateRecipe {
  return validateTemplateRecipe({
    schemaVersion: 1, id: "template-one", name: "A personal template", revision: 0, scope: { kind: "account", ownerId: "private-owner" }, createdAt: templateTimestamp, updatedAt: templateTimestamp,
    canvas: { width: 536, height: 1600 }, requiredSources: { A: 1 },
    slots: [{ id: "slot-one", role: "A", sourceIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.7, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } }],
    layers: [{ id: "caption-one", kind: "text", text: "Private names", personal: false, x: 0.1, y: 0.85, width: 0.8, height: 0.1, rotation: 0, font: "sans", fontSize: 0.06, colour: "#111111", align: "center" }, ...(withDecoration ? [{ id: "decoration-layer", kind: "decoration", mediaId: "png-one", fit: "contain", x: 0, y: 0, width: 0.1, height: 0.1, rotation: 0 }] : [])],
    decorations: withDecoration ? [{ id: "png-one", kind: "decoration", mime: "image/png", bytes: templatePixel().size, width: 1, height: 1 }] : [],
    look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Our anniversary", showDate: true },
  });
}
