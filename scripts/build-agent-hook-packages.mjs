import fs from 'node:fs/promises';
import path from 'node:path';
import { copyPluginPublicSource } from '../plugins/contracts/plugin-sdk/public-source.mjs';

const root = process.cwd();
const output = path.join(root, 'dist', 'agent-hooks');
await fs.mkdir(path.join(output, '.agents', 'plugins'), { recursive: true });
const codexMarketplace = JSON.parse(await fs.readFile(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
for (const plugin of codexMarketplace.plugins) if (plugin.source?.path) plugin.source.path = plugin.source.path.replace('./src/plugins/', './plugins/');
await fs.writeFile(path.join(output, '.agents/plugins/marketplace.json'), JSON.stringify(codexMarketplace, null, 2) + '\n');
// CodeBuddy reads marketplaces from `.codebuddy-plugin/marketplace.json`, so the
// WorkBuddy hook package ships its own manifest instead of relying on a network
// marketplace; `codebuddy plugin install` then works fully offline.
await fs.mkdir(path.join(output, '.codebuddy-plugin'), { recursive: true });
const codebuddyMarketplace = JSON.parse(await fs.readFile(path.join(root, '.codebuddy-plugin/marketplace.json'), 'utf8'));
for (const plugin of codebuddyMarketplace.plugins) if (typeof plugin.source === 'string') plugin.source = plugin.source.replace('./src/plugins/', './plugins/');
await fs.writeFile(path.join(output, '.codebuddy-plugin/marketplace.json'), JSON.stringify(codebuddyMarketplace, null, 2) + '\n');
for (const name of ['rabi-codex-context', 'rabi-dsh-context', 'rabi-workbuddy-context', 'rabi-antigravity-context']) {
  const source = path.join(root, 'src/plugins', name);
  await copyPluginPublicSource(source, path.join(output, 'plugins', name), { replace: true });
  if (name !== 'rabi-dsh-context') await fs.copyFile(path.join(root, 'scripts/lib/timeout-settings.mjs'), path.join(output, 'plugins', name, 'scripts/lib/timeout-settings.mjs'));
  if (name !== 'rabi-dsh-context') await fs.copyFile(path.join(root, 'scripts/lib/windows-host-discovery.mjs'), path.join(output, 'plugins', name, 'scripts/lib/windows-host-discovery.mjs'));
}
console.log('Built Codex, DSH, WorkBuddy and Antigravity Hook installation packages.');

await import("./build-instance-agent-runtime.mjs");
