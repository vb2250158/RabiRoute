import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'dist', 'agent-hooks');
await fs.mkdir(path.join(output, '.agents', 'plugins'), { recursive: true });
await fs.copyFile(path.join(root, '.agents', 'plugins', 'marketplace.json'), path.join(output, '.agents', 'plugins', 'marketplace.json'));
// CodeBuddy reads marketplaces from `.codebuddy-plugin/marketplace.json`, so the
// WorkBuddy hook package ships its own manifest instead of relying on a network
// marketplace; `codebuddy plugin install` then works fully offline.
await fs.mkdir(path.join(output, '.codebuddy-plugin'), { recursive: true });
await fs.copyFile(path.join(root, '.codebuddy-plugin', 'marketplace.json'), path.join(output, '.codebuddy-plugin', 'marketplace.json'));
for (const name of ['rabi-codex-context', 'rabi-dsh-context', 'rabi-workbuddy-context', 'rabi-antigravity-context']) {
  const source = path.join(root, 'plugins', name);
  await fs.cp(source, path.join(output, 'plugins', name), {
    recursive: true, force: true,
    filter: file => !['node_modules', '.git', 'test', 'tests'].includes(path.basename(file)) && !file.endsWith('.test.mjs')
  });
}
console.log('Built Codex, DSH, WorkBuddy and Antigravity Hook installation packages.');

await import("./build-instance-agent-runtime.mjs");
