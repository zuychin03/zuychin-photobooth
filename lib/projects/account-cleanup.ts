import { openProjectRepository, type ProjectRepository } from "./storage";
import type { ProjectScope } from "./model";

export interface AccountCleanupResult { removed: number; retained: number; incomplete: boolean }
type CleanupRepository = Pick<ProjectRepository, "list" | "delete" | "close">;

export async function removeLocalAccountCopies(ownerId: string, openRepository: (scope: ProjectScope) => Promise<CleanupRepository> = openProjectRepository): Promise<AccountCleanupResult> {
  const repository = await openRepository({ kind: "account", ownerId });
  const result: AccountCleanupResult = { removed: 0, retained: 0, incomplete: false };
  try {
    for (const project of await repository.list()) {
      if (project.readOnly) { result.retained++; continue; }
      try { await repository.delete(project.id, project.revision); result.removed++; }
      catch { result.retained++; result.incomplete = true; }
    }
    try { result.retained = (await repository.list()).length; }
    catch { result.incomplete = true; }
    return result;
  } finally { repository.close(); }
}
