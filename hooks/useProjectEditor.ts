"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { projectEditorIdentity, projectEditorRecovery } from "@/lib/projects/editor-queue";
import type { PhotoProject, ProjectEditorSettings } from "@/lib/projects/model";

// Key the editor by scope and project ID so private drafts never share a queue.
export function useProjectEditor(project: PhotoProject, persist: (patch: Partial<ProjectEditorSettings>) => Promise<void>) {
  const [queue] = useState(() => projectEditorRecovery.acquire(projectEditorIdentity(project), project.editor, persist));
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  useEffect(() => { queue.setPersist(persist); }, [persist, queue]);
  useEffect(() => { queue.activate(); return () => queue.detach(); }, [queue]);
  const patch = useCallback((value: Partial<ProjectEditorSettings>) => queue.patch(value), [queue]);
  const setField = useCallback(<K extends keyof ProjectEditorSettings>(key: K, value: ProjectEditorSettings[K] | ((previous: ProjectEditorSettings[K]) => ProjectEditorSettings[K])) => queue.setField(key, value), [queue]);
  const flush = useCallback(() => queue.flush(), [queue]);
  const replaceFromProject = useCallback((editor: ProjectEditorSettings) => queue.replaceFromProject(editor), [queue]);
  const discardUnsaved = useCallback(() => queue.discardUnsaved(project.editor), [queue, project.editor]);
  return { ...state, patch, setField, flush, replaceFromProject, discardUnsaved };
}
