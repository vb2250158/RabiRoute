/** Shared browser dependencies are an activation contract, never an API permission list. */
export const WEB_RUNTIME_ABI = 'rabi-web-runtime/1';
export const WEB_RUNTIME_KEY = '__RABIROUTE_WEB_RUNTIME_V1__';
export function missingWebRuntimeImports(required, runtime) {
  if (!runtime || runtime.abi !== required.abi) return ['runtime ABI ' + required.abi];
  const missing = [];
  for (const dependency of required.imports ?? []) {
    const namespace = runtime.modules[dependency.id];
    for (const name of dependency.exports) if (!namespace || !Object.hasOwn(namespace, name)) missing.push(dependency.id + ':' + name);
  }
  return missing;
}
