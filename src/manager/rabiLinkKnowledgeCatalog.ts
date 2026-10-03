import { normalizePathForComparison } from "../shared/pathPolicy.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

/** Public knowledge APIs resolve roles under the Manager's global storage owner. */
export function localKnowledgeRoleIds(personas: readonly RouteCatalogPersonaPresentation[], rolesRoot: string): string[] {
  const owner = normalizePathForComparison(rolesRoot);
  return [...new Set(personas.filter(item => item.isPersona && normalizePathForComparison(item.rolesRoot) === owner).map(item => item.roleId))];
}
