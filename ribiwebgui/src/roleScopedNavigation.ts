export function roleConfigPath(roleId: string): string {
  return roleId ? `/roles/${encodeURIComponent(roleId)}/config` : "/roles";
}
export function roleKnowledgePath(roleId: string): string {
  return roleId ? `/roles/${encodeURIComponent(roleId)}/knowledge` : "/roles/knowledge";
}
export function isRolePage(path: string): boolean { return path === "/roles" || path.startsWith("/roles/"); }

export function roleMessageHistoryPath(roleId: string): string {
  return roleId ? `/roles/${encodeURIComponent(roleId)}/message-history` : "/roles/message-history";
}
