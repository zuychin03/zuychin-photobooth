import assert from "node:assert/strict";
import { test } from "node:test";
import { runCaptureSequence } from "../lib/capture-sequence";
import { appendProjectMedia, applyProjectEdit, createProject, type ProjectMedia } from "../lib/projects/model";

const photo = (id: string): ProjectMedia => ({ id, participantId: "person", kind: "photo", mime: "image/png", bytes: 100, width: 10, height: 10 });

for (const failure of [false, true]) {
  test(`selected retakes preserve other originals and design${failure ? " when a later save fails" : ""}`, async () => {
    const draft = createProject({ id: "retake-project", participants: [{ id: "person", role: "A" }] });
    const originalIds = ["one", "two", "three", "four"];
    let project = appendProjectMedia(draft, originalIds.map(photo), { ...draft.sourceOrder, A: originalIds }, draft.createdAt);
    project = applyProjectEdit(project, { sourceOrder: project.sourceOrder, editor: { ...project.editor, caption: "Keep this design", filterId: "none" } });
    const before = project;
    const saved: number[] = [];
    let serial = 0;
    const run = runCaptureSequence([1, 3], 3, {
      cancelled: () => false,
      pause: async () => {},
      countdown: () => {},
      capture: () => photo(`replacement-${++serial}`),
      persist: async (index, replacement) => {
        if (failure && index === 3) throw new Error("Storage full");
        const order = [...project.sourceOrder.A];
        order[index] = replacement.id;
        project = appendProjectMedia(project, [replacement], { ...project.sourceOrder, A: order }, project.createdAt);
      },
      saved: index => { saved.push(index); },
    });
    if (failure) await assert.rejects(run, /Storage full/);
    else assert.equal(await run, true);
    assert.deepEqual(project.sourceOrder.A, ["one", "replacement-1", "three", failure ? "four" : "replacement-2"]);
    assert.deepEqual(saved, failure ? [1] : [1, 3]);
    assert.deepEqual(project.editor, before.editor);
    assert.equal(project.id, before.id);
    assert.deepEqual(before.sourceOrder.A, originalIds);
    assert.ok(originalIds.every(id => project.media.some(item => item.id === id)));
  });
}
