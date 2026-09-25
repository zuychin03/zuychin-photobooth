import { openTemplateShelf, type TemplateShelf } from "./storage";
import type { TemplateScope } from "./model";

export interface TemplateAccountCleanupResult { removed: number; retained: number; incomplete: boolean }
type CleanupShelf = Pick<TemplateShelf, "list" | "delete" | "close">;

export async function removeLocalAccountTemplates(ownerId: string, openShelf: (scope: TemplateScope) => Promise<CleanupShelf> = openTemplateShelf): Promise<TemplateAccountCleanupResult> {
  const shelf = await openShelf({ kind: "account", ownerId }), result: TemplateAccountCleanupResult = { removed: 0, retained: 0, incomplete: false };
  try {
    for (const template of await shelf.list()) {
      if (template.readOnly) { result.retained++; continue; }
      try { await shelf.delete(template.id, template.revision); result.removed++; }
      catch { result.retained++; result.incomplete = true; }
    }
    try { result.retained = (await shelf.list()).length; } catch { result.incomplete = true; }
    return result;
  } finally { shelf.close(); }
}
