export type RoleKnowledgeResource =
  | "plans"
  | "skills"
  | "memory"
  | "memory/recent"
  | "memory/consolidated"
  | "memory/consolidation-requests"
  | "memory/consolidation-runs";

export type RoleKnowledgeResourceRoute = {
  roleId: string;
  resource: RoleKnowledgeResource;
  itemId: string;
};

const roleKnowledgeResourcePattern = /^\/(?:api\/)?roles\/([^/]+)\/(memory\/consolidation-requests|memory\/consolidation-runs|memory\/consolidated|memory\/recent|memory|plans|skills)(?:\/([^/]+))?$/;

export function parseRoleKnowledgeResourceRoute(pathname: string): RoleKnowledgeResourceRoute | null {
  const match = pathname.match(roleKnowledgeResourcePattern);
  if (!match) return null;
  return {
    roleId: decodeURIComponent(match[1]),
    resource: match[2] as RoleKnowledgeResource,
    itemId: match[3] ? decodeURIComponent(match[3]) : ""
  };
}
