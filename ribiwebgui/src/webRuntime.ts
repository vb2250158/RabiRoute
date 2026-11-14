import { WEB_RUNTIME_ABI, WEB_RUNTIME_KEY, missingWebRuntimeImports, type WebRuntime, type WebRuntimeImports } from '../../plugins/contracts/plugin-sdk/web-runtime.mjs';

const scope = globalThis as typeof globalThis & { [key: string]: unknown };
/** Called before any plugin activation; namespaces are the shell's actual ESM instances. */
export function installWebRuntime(modules: WebRuntime['modules']): void {
  scope[WEB_RUNTIME_KEY] = Object.freeze({ abi: WEB_RUNTIME_ABI, modules: Object.freeze(modules) });
}
export function checkWebRuntime(required: WebRuntimeImports): void {
  const missing = missingWebRuntimeImports(required, scope[WEB_RUNTIME_KEY] as WebRuntime | undefined);
  if (missing.length) throw new Error('This Web plugin candidate needs a compatible shared runtime: ' + missing.join(', '));
}
