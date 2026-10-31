/** Unset means every user-configured package root can use its declared execution mode. */
export function configuredInProcessRoots(env: NodeJS.ProcessEnv = process.env): readonly string[] | undefined {
  const value = env.RABIROUTE_PLUGIN_IN_PROCESS_ROOTS;
  if (value === undefined || !value.trim()) return undefined;
  let roots: unknown;
  try { roots = JSON.parse(value); } catch { throw new Error("RABIROUTE_PLUGIN_IN_PROCESS_ROOTS must be a JSON array of package-root paths. Clear this Manager startup setting to allow all configured package roots."); }
  if (!Array.isArray(roots) || roots.some(root => typeof root !== "string" || !root.trim())) {
    throw new Error("RABIROUTE_PLUGIN_IN_PROCESS_ROOTS must be a JSON array of nonempty package-root paths; [] disables in_process entries. Clear this Manager startup setting to remove the restriction.");
  }
  return roots.map(root => root.trim());
}

export type PluginExecutionConfigurationDiagnostic = Readonly<{
  field: "RABIROUTE_PLUGIN_IN_PROCESS_ROOTS";
  message: string;
}>;

/** Invalid optional settings are diagnosed and skipped; valid explicit restrictions are preserved. */
export function resolveInProcessRoots(env: NodeJS.ProcessEnv = process.env): Readonly<{
  roots: readonly string[] | undefined;
  diagnostics: readonly PluginExecutionConfigurationDiagnostic[];
}> {
  try { return Object.freeze({ roots: configuredInProcessRoots(env), diagnostics: Object.freeze([]) }); }
  catch {
    return Object.freeze({ roots: undefined, diagnostics: Object.freeze([Object.freeze({
      field: "RABIROUTE_PLUGIN_IN_PROCESS_ROOTS" as const,
      message: "RABIROUTE_PLUGIN_IN_PROCESS_ROOTS must be a JSON array of nonempty package-root paths. This invalid optional setting was skipped; configured packages keep their declared execution modes. Change or clear this Manager startup setting."
    })]) });
  }
}
