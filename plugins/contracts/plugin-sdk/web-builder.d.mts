import type { InlineConfig, Plugin } from 'vite';
export interface WebRuntimeModule { id: string; specifier?: string; source?: string; exports: readonly string[] }
export interface WebRuntimeCatalog { schemaVersion: 1; abi: string; modules: readonly WebRuntimeModule[] }
export interface WebResourceFile { path: string; sha256: string; size: number; contentType: string }
export interface WebPackageManifest {
  schemaVersion: 1; kind: 'rabi-plugin-web'; pluginId: string; version: string; entry: string;
  runtime: { abi: string; imports: { id: string; exports: string[] }[] };
  backend: { pluginId: string; version: string }; styles: string[]; files: WebResourceFile[];
}
export interface WebPluginBuildOptions {
  sourceDirectory?: string; outputDirectory?: string; runtimeCatalog: WebRuntimeCatalog | string;
  entry?: string; referenceRoot?: string; aliases?: Record<string, string>; contentTypes?: Record<string, string>; assetsInlineLimit?: number; logLevel?: 'info' | 'warn' | 'error' | 'silent';
  toolchain?: { build(options: InlineConfig): Promise<unknown>; vue(): Plugin };
}
export interface WebPluginBuildResult {
  outputDirectory: string; manifest: WebPackageManifest; manifestSha256: string; runtimeCatalogSha256: string;
  /** Private build input paths, not fields in the public package manifest. */
  inputs: { path: string; sha256: string }[]; toolchain: { node: string; builderSha256: string };
}
export function buildPluginWebPackage(options: WebPluginBuildOptions): Promise<WebPluginBuildResult>;
export function webRuntimeVitePlugin(root: string, modules: readonly Omit<WebRuntimeModule, 'exports'>[], options?: { importer?: string }): Plugin;
export function pluginWebRuntimeProxy(root: string, manifest: WebRuntimeCatalog): Plugin & { requiredImports(): WebPackageManifest['runtime'] };
export function pluginEntryStyles(manifest: Record<string, { isEntry?: boolean; css?: string[]; imports?: string[]; dynamicImports?: string[] }>): string[];
