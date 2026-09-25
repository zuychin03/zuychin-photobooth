import type { ProjectScope } from "./model";
import { openProjectRepository, type ProjectListItem, type ProjectRepository } from "./storage";

export interface RecentProject extends ProjectListItem { scope: ProjectScope; key: string }
export async function loadRecentProjects(ownerId: string | null, assertActive: () => void, open: (scope: ProjectScope) => Promise<Pick<ProjectRepository, "list" | "close">> = openProjectRepository): Promise<RecentProject[]> {
  const scopes: ProjectScope[] = [{ kind: "device" }, ...(ownerId ? [{ kind: "account" as const, ownerId }] : [])];
  const recent: RecentProject[] = [];
  for (const scope of scopes) {
    assertActive();
    const repository = await open(scope);
    try {
      assertActive();
      const rows = await repository.list();
      assertActive();
      for (const row of rows) recent.push({ ...row, scope, key: `${scope.kind === "device" ? "device" : scope.ownerId}/${row.id}` });
    } finally { repository.close(); }
  }
  return recent.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.key.localeCompare(b.key)).slice(0, 3);
}
