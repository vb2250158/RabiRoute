import { isPortableSkillArchiveSegment } from "../shared/skillArchivePath.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";

export type RoleKnowledgeResource =
  | "counts"
  | "plans"
  | "plan-statuses"
  | "plan-marker-statuses"
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

export function parseRoleSkillDownloadRoute(pathname: string): { roleId: string; skillId: string } | null {
  const match = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/skills\/([^/]+)\/download$/);
  if (!match) return null;
  const roleId = decodeURIComponent(match[1]);
  const skillId = decodeURIComponent(match[2]);
  if (!isPortableSkillArchiveSegment(roleId) || sanitizeRoleId(roleId) !== roleId
    || !isPortableSkillArchiveSegment(skillId) || skillId.includes("%")) {
    throw new Error("Invalid skill download path.");
  }
  return { roleId, skillId };
}

const roleKnowledgeResourcePattern = /^\/(?:api\/)?roles\/([^/]+)\/(memory\/consolidation-requests|memory\/consolidation-runs|memory\/consolidated|memory\/recent|memory|counts|plan-statuses|plan-marker-statuses|plans|skills)(?:\/([^/]+))?$/;

export function parseRoleKnowledgeResourceRoute(pathname: string): RoleKnowledgeResourceRoute | null {
  const match = pathname.match(roleKnowledgeResourcePattern);
  if (!match) return null;
  return {
    roleId: decodeURIComponent(match[1]),
    resource: match[2] as RoleKnowledgeResource,
    itemId: match[3] ? decodeURIComponent(match[3]) : ""
  };
}
