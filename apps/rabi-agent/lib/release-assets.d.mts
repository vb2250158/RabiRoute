export function normalizeReleaseAssetPath(value: string): string;
export type ReleaseAssetOptions = { pluginSourceRoot?: string };
export function collectReleaseAssetPaths(root: string, relative?: string, options?: ReleaseAssetOptions): string[];
export function readReleaseAsset(root: string, relative: string, options?: ReleaseAssetOptions): Buffer;
