import { ROLES, type Role } from "../layouts";
import { validateTemplateDesign, type TemplateDesign, type TemplateRecipe } from "./model";

export function designFromRecipe(recipe: TemplateRecipe): TemplateDesign {
  const { canvas, requiredSources, slots, layers, decorations, look, defaults, places } = recipe;
  return validateTemplateDesign({ canvas, requiredSources, slots, layers, decorations, look, defaults, ...(places ? { places } : {}) });
}
export function templateForNewProject(input: TemplateDesign): { design: TemplateDesign; roles: Role[]; mode: "solo" | "duo" | "group"; requiredShots: 1 | 2 | 3 | 4; layoutId: string } {
  const checked = validateTemplateDesign(input), sourceRoles = ROLES.filter(role => checked.requiredSources[role]), roles = ROLES.slice(0, sourceRoles.length);
  const mapping = new Map(sourceRoles.map((role, index) => [role, roles[index]]));
  const requiredSources = Object.fromEntries(sourceRoles.map(role => [mapping.get(role)!, checked.requiredSources[role]]));
  const places = checked.places ? Object.fromEntries(Object.entries(checked.places).map(([role, place]) => [mapping.get(role as Role)!, place])) : undefined;
  const design = validateTemplateDesign({ ...checked, requiredSources, ...(places ? { places } : {}), slots: checked.slots.map(slot => ({ ...slot, role: mapping.get(slot.role)!, ...(slot.companions ? { companions: slot.companions.map(companion => ({ ...companion, role: mapping.get(companion.role)! })) } : {}) })) });
  return { design, roles, mode: roles.length === 1 ? "solo" : roles.length === 2 ? "duo" : "group", requiredShots: Math.max(...sourceRoles.map(role => checked.requiredSources[role]!)) as 1 | 2 | 3 | 4, layoutId: roles.length === 1 ? "strip4" : roles.length === 2 ? "duo-alternate" : roles.length === 3 ? "trio" : "quad" };
}
