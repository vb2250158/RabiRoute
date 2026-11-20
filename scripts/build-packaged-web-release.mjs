import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWebPatch, verifyWebPatch, webPatchBackend } from '../dist/manager/webPatchCatalog.js';

/** Bind the standard Web snapshot to the final, privacy-filtered runtime payload. */
export async function buildPackagedWebRelease(packageRoot) {
  const root = path.resolve(packageRoot);
  const output = path.join(root, 'dist', 'web-patches');
  const revision = await buildWebPatch(root, output);
  const candidateRoot = path.join(output, revision);
  const manifest = await verifyWebPatch(candidateRoot, revision);
  if (manifest.backend !== await webPatchBackend(root)) throw new Error('Packaged backend changed during Web snapshot construction.');
  await fs.copyFile(path.join(candidateRoot, 'manifest.json'), path.join(root, 'ribiwebgui', 'web-release.json'));
  return { revision, backend: manifest.backend, candidateRoot, files: manifest.files.length,
    legacyModules: manifest.modules.length, moduleDiagnostics: manifest.moduleDiagnostics ?? [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--package-root');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: --package-root <final payload>');
  console.log(JSON.stringify(await buildPackagedWebRelease(process.argv[index + 1])));
}
