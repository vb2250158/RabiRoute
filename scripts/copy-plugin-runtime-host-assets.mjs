import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
