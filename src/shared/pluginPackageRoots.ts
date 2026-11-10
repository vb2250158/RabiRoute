import path from "node:path";
import type { RuntimeLayout } from "./runtimeLayout.js";

export type PluginPackageRootsEnvironment = Readonly<{
  RABIROUTE_PLUGIN_PACKAGE_ROOTS?: string;
}>;

/** Installed packages share the Manager's original store in every application entrance. */
export function resolvePluginPackageRoots(
  layout: RuntimeLayout,
  environment: PluginPackageRootsEnvironment = process.env
): readonly string[] {
  const additional = (environment.RABIROUTE_PLUGIN_PACKAGE_ROOTS ?? "")
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));
  return Object.freeze([...new Set([
    path.join(layout.packageRoot, "dist", "plugins", "packages"),
    path.join(layout.stateRoot, "data", "plugins", "packages"),
    ...additional
  ])]);
}
