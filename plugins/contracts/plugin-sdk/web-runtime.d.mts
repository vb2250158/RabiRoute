export const WEB_RUNTIME_ABI: string;
export const WEB_RUNTIME_KEY: string;
export type WebRuntimeImports = { abi: string; imports: readonly { id: string; exports: readonly string[] }[] };
export type WebRuntime = { abi: string; modules: Record<string, Record<string, unknown>> };
export function missingWebRuntimeImports(required: WebRuntimeImports, runtime: WebRuntime | undefined): string[];
