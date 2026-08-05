import path from "node:path";

export type ConfigWatchDirectoryRule = {
  discovery: boolean;
  fileNames: ReadonlySet<string>;
};

export function configWatchDirectoryRules(
  routeRoot: string,
  rolesRoot: string,
  files: string[]
): Map<string, ConfigWatchDirectoryRule> {
  const mutable = new Map<string, { discovery: boolean; fileNames: Set<string> }>();
  const ensure = (directory: string) => {
    const resolved = path.resolve(directory);
    let rule = mutable.get(resolved);
    if (!rule) {
      rule = { discovery: false, fileNames: new Set<string>() };
      mutable.set(resolved, rule);
    }
    return rule;
  };
  ensure(routeRoot).discovery = true;
  ensure(rolesRoot).discovery = true;
  for (const file of files) {
    ensure(path.dirname(file)).fileNames.add(path.basename(file).toLowerCase());
  }
  return mutable;
}

export function configWatchEventMatches(
  rule: ConfigWatchDirectoryRule,
  eventType: string,
  fileName: string | Buffer | null
): boolean {
  if (rule.discovery && eventType === "rename") return true;
  if (rule.fileNames.size === 0) return false;
  if (fileName === null) return true;
  return rule.fileNames.has(path.basename(fileName.toString()).toLowerCase());
}
