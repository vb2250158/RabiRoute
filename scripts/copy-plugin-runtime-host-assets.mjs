import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublicPluginSource } from '../plugins/contracts/plugin-sdk/public-source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src/plugin-runtime-host/bridge'), target = path.join(root, 'dist/plugin-runtime-host/bridge');
await fs.mkdir(target, { recursive: true });
// Exact native runtime assets, not a repository or node_modules copy. These
// execute in Node and have adjacent checked TypeScript interface declarations.
for (const name of ['executor.mjs', 'protocol.mjs', 'child.mjs']) {
  const input = path.join(source, name); const stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid plugin runtime asset: ${name}`);
  await fs.copyFile(input, path.join(target, name));
}

// Native host imports reuse the same compiled owners. Adjacent data and raw
// Node helpers keep their source-relative locations; private state is excluded.
const pluginSources = path.join(root, 'src/plugins');
for (const entry of await fs.readdir(pluginSources, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('io.rabiroute.')) continue;
  const sourceRoot = path.join(pluginSources, entry.name);
  async function copyAssets(directory) {
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      const input = path.join(directory, child.name), relative = path.relative(sourceRoot, input);
      if (!isPublicPluginSource(relative) || relative.split(path.sep)[0] === 'web') continue;
      if (child.isDirectory()) { await copyAssets(input); continue; }
      if (!child.isFile() || /\.(?:ts|tsx|vue)$/.test(child.name)) continue;
      const output = path.join(root, 'dist/plugins', entry.name, relative);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(input, output);
    }
  }
  await copyAssets(sourceRoot);
}

// Trusted process bootstrap and kernel Job bridge must remain adjacent at runtime.
const processRuntimeSource = path.join(root, 'src/runtime');
const processRuntimeTarget = path.join(root, 'dist/runtime');
await fs.mkdir(processRuntimeTarget, { recursive: true });
for (const name of ['windowsJobObject.mjs', 'protectedProcessLauncher.mjs', 'protectedProcessBootstrap.mjs']) {
  const input = path.join(processRuntimeSource, name);
  const stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid process runtime asset: ${name}`);
  await fs.copyFile(input, path.join(processRuntimeTarget, name));
}
