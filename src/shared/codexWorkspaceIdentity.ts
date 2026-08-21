/**
 * Browser-safe workspace comparison for configuration normalization.
 * Node delivery paths add realpath-based alias resolution in codexTaskIdentity.
 */
function withoutWindowsNamespace(value: string): string {
  const uncPrefix = "\\\\?\\UNC\\";
  const localPrefix = "\\\\?\\";
  if (value.startsWith(uncPrefix)) return "\\\\" + value.slice(uncPrefix.length);
  if (value.startsWith(localPrefix)) return value.slice(localPrefix.length);
  return value;
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
}

export function canonicalCodexWorkspaceSyntax(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const normalized = withoutWindowsNamespace(trimmed)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return isWindowsPath(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

export function sameCodexWorkspaceSyntax(left: string | undefined, right: string | undefined): boolean {
  const leftKey = canonicalCodexWorkspaceSyntax(left);
  const rightKey = canonicalCodexWorkspaceSyntax(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}