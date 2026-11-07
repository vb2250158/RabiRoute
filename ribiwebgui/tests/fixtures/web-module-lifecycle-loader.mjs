export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("/api/plugins/modules/")) return nextResolve(specifier, context);
  const parts = specifier.split("/");
  const id = decodeURIComponent(parts[4]), revision = parts[5];
  const source = `export function activate(api) { return globalThis.__webModuleLifecycleTest.activate(${JSON.stringify(id)}, ${JSON.stringify(revision)}, api); }`;
  return {url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true};
}
