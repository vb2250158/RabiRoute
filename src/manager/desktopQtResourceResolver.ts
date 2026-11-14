import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PluginPackageCatalog } from '../plugin-kernel/profile.js';
import { resolvePluginPackageFile } from '../plugin-kernel/packageLoader.js';
import type { LanAgentReleaseStore } from './lanAgentReleaseStore.js';
import { desktopResourceReference, type DesktopResourceReference } from '../../apps/rabi-agent/lib/desktop-resource-reference.mjs';

/** Compose independently verified resource references; never chooses common/node SDK versions. */
export function createDesktopResourceResolver(options: {
  native: Pick<LanAgentReleaseStore, 'desktopResourceRelease'>;
  packages(): Pick<PluginPackageCatalog, 'loadPackage'>;
  runtimeRoot?: string;
}) {
  return async (input: unknown, previous: DesktopResourceReference = {}, context: { restoring?: boolean } = {}) => {
    const reference = desktopResourceReference(input, previous);
    const native = reference.digest ? options.native.desktopResourceRelease(reference.digest) : { version: 'builtin', nativeOptions: {} };
    let qtPresentation: { command: string; args: string[] } | undefined;
    let presentationIssue: Readonly<{ code: string; message: string }> | undefined;
    try { if (reference.qtPackageRef) {
      const pin = reference.qtPackageRef;
      // The same package owner uses its full content revision as the cache key.
      // Avoid id/version nesting for executable/DLL paths on Windows.
      const loaded = await options.packages().loadPackage(pin.id, pin.version, options.runtimeRoot ?? path.join(os.tmpdir(), 'rr-qt'), 'desktop', { layout: 'revision' });
      if (loaded.manifest.id !== pin.id || loaded.manifest.version !== pin.version || loaded.revision !== pin.revision || loaded.execution !== 'declarative') throw new Error('The selected Qt resource package differs from its exact imported identity.');
      const descriptor = JSON.parse(await fs.readFile(loaded.entryPath, 'utf8'));
      if (descriptor?.schemaVersion !== 1 || descriptor.protocol !== 'rabi-computer-overlay-jsonl@1' || descriptor.platform !== `${process.platform}-${process.arch}` || typeof descriptor.command !== 'string' || typeof descriptor.overlay !== 'string' || !Array.isArray(descriptor.files) || !Array.isArray(descriptor.dependencies) || !Array.isArray(descriptor.notices)) throw new Error('The selected Qt resource descriptor is incompatible or incomplete.');
      const [command, overlay] = await Promise.all([resolvePluginPackageFile(loaded.runtimeRoot, descriptor.command), resolvePluginPackageFile(loaded.runtimeRoot, descriptor.overlay)]);
      qtPresentation = { command, args: ['-B', overlay] };
    } } catch (error) {
      if (!context.restoring) throw error;
      presentationIssue = Object.freeze({ code: 'COMPUTER_PRESENTATION_UNAVAILABLE', message: `The selected Qt resource ${reference.qtPackageRef!.id}@${reference.qtPackageRef!.version} is unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
    return Object.freeze({ ...native, ...(reference.digest ? { digest: reference.digest } : {}),
      qtPackageRef: reference.qtPackageRef,
      ...(presentationIssue ? { presentationIssue } : {}),
      nativeOptions: Object.freeze({ ...native.nativeOptions, ...(presentationIssue ? { qtPresentation: null, presentationIssue } : qtPresentation ? { qtPresentation } : {}) }) });
  };
}
