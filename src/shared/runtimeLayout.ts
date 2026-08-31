import path from "node:path";

export type RuntimeLayout = Readonly<{
  packageRoot: string;
  stateRoot: string;
}>;

export type RuntimeLayoutEnvironment = Readonly<{
  RABIROUTE_PACKAGE_ROOT?: string;
  RABIROUTE_STATE_ROOT?: string;
}>;

function explicitAbsoluteRoot(value: string | undefined, variableName: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${variableName} must be an absolute path.`);
  }
  return path.resolve(candidate);
}

/**
 * One runtime layout contract shared by source mode and the packaged Host.
 * Package assets are immutable and versioned; state remains under the stable
 * application root. Host-provided environment overrides are explicit so a
 * changed process cwd can never silently select another state tree.
 */
export function resolveRuntimeLayout(
  defaultPackageRoot: string,
  environment: RuntimeLayoutEnvironment = process.env
): RuntimeLayout {
  if (!path.isAbsolute(defaultPackageRoot)) {
    throw new Error("defaultPackageRoot must be an absolute path.");
  }
  const packageRoot = explicitAbsoluteRoot(environment.RABIROUTE_PACKAGE_ROOT, "RABIROUTE_PACKAGE_ROOT")
    ?? path.resolve(defaultPackageRoot);
  const stateRoot = explicitAbsoluteRoot(environment.RABIROUTE_STATE_ROOT, "RABIROUTE_STATE_ROOT")
    ?? packageRoot;
  return Object.freeze({ packageRoot, stateRoot });
}
