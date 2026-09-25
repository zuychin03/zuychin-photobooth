import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createProject } from "../../../lib/projects/model";
import { inspectImageHeader } from "../../../lib/projects/images";
import { exportTemplateBundle, importTemplateBundle, templateBlobHash } from "../../../lib/templates/bundle";
import { templateFromProject } from "../../../lib/templates/from-project";
import { validateTemplateRecipe } from "../../../lib/templates/model";

async function generate() {
  const timestamp = "2026-09-23T00:00:00.000Z", file = await readFile(new URL("../projects/b.png", import.meta.url));
  const png = new Blob([new Uint8Array(file)], { type: "image/png" }), dimensions = inspectImageHeader(new Uint8Array(await png.arrayBuffer()));
  const design = templateFromProject(createProject({ id: "synthetic-template-project", createdAt: timestamp, captureTimeZone: "Australia/Sydney", editor: { layoutId: "strip4", caption: "Synthetic private caption: do not export" } }));
  const recipe = validateTemplateRecipe({ ...design, schemaVersion: 1, id: "synthetic-template", name: "Synthetic four-photo frame", revision: 0, scope: { kind: "account", ownerId: "synthetic-private-owner" }, createdAt: timestamp, updatedAt: timestamp,
    decorations: [{ id: "synthetic-decoration", kind: "decoration", mime: "image/png", bytes: png.size, width: dimensions.width, height: dimensions.height }],
    layers: [
      { kind: "decoration", id: "decoration-layer", mediaId: "synthetic-decoration", fit: "contain", x: 0.86, y: 0.93, width: 0.08, height: 0.02, rotation: 0 },
      { kind: "text", id: "private-text", text: "Synthetic personal names: remove this", personal: true, x: 0.08, y: 0.94, width: 0.7, height: 0.03, rotation: 0, font: "sans", fontSize: 0.035, colour: "#292524", align: "center" },
    ],
  });
  const inspect = async (blob: Blob) => inspectImageHeader(new Uint8Array(await blob.arrayBuffer()));
  const bundle = await exportTemplateBundle(recipe, new Map([["synthetic-decoration", png]]), { inspect });
  const imported = await importTemplateBundle(bundle, { inspect, newId: () => "verified-import", now: () => timestamp });
  assert.equal(imported.recipe.defaults.caption, ""); assert.deepEqual(imported.recipe.scope, { kind: "device" });
  assert.equal(imported.recipe.layers.find(layer => layer.kind === "text")?.text, "");
  assert.equal(await templateBlobHash(imported.decorations.get("synthetic-decoration")!), await templateBlobHash(png));
  await writeFile(new URL("./synthetic.pbtemplate", import.meta.url), new Uint8Array(await bundle.arrayBuffer()));
  process.stdout.write(`Synthetic template: ${bundle.size} bytes; four slots; one original PNG; captions and text blank.\n`);
}
void generate();
