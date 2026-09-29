import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function closure(entry, available) {
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    assert(available.has(file), `Missing runtime module: ${file}`);
    visited.add(file);
    const source = await fs.readFile(path.join(root, 'scripts', file), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert(!next.startsWith('../'), 'Runtime dependency escapes scripts');
      await visit(next);
    }
  }
  await visit(entry);
  return visited;
}
test('Relay manifest includes the full actual static relative import closure', async () => {
  const files = JSON.parse(await fs.readFile(path.join(root, 'scripts/rabilink-relay-runtime-files.json'), 'utf8'));
  assert.equal(new Set(files).size, files.length);
  const found = await closure('rabilink-relay-server.mjs', new Set(files));
  assert.deepEqual([...found].sort(), files.slice().sort());
  const missing = new Set(files); missing.delete('rabilink-agent-profile.mjs');
  await assert.rejects(closure('rabilink-relay-server.mjs', missing), /Missing runtime module/);
});
test('Windows release explicitly includes runtime schema outside tracked-tree enumeration', async () => {
  const script = await fs.readFile(path.join(root, 'scripts/build-windows-release.ps1'), 'utf8');
  const required = script.match(/\$requiredPortableRuntimeFiles = @\(([\s\S]*?)\n\)/)?.[1];
  assert(required?.includes('packages/rabi-knowledge-contract/schema.mjs'));
  assert(required?.includes('scripts/rabilink-relay-runtime-files.json'));
  assert(required?.includes('scripts/lib/release-tracked-manifest.ps1'));
  for (const topic of ['aiui-agent-profile-http', 'rabilink-knowledge-operation-receipts', 'knowledge-grant-phone-ui']) {
    for (const suffix of ['', '_en']) assert(required?.includes(`docs/${topic}${suffix}.md`));
  }
  assert(script.includes('$requiredPortableRuntimeFiles += "scripts/$relative"'));
  assert(script.includes("Get-Content -LiteralPath (Join-Path $repo 'scripts/rabilink-relay-runtime-files.json')"));
  const runtime = await fs.readFile(path.join(root, 'src/manager/rabiLinkKnowledgeRuntime.ts'), 'utf8');
  assert(runtime.includes('../../packages/rabi-knowledge-contract/schema.mjs'));
  assert.equal(path.posix.normalize('dist/manager/../../packages/rabi-knowledge-contract/schema.mjs'), 'packages/rabi-knowledge-contract/schema.mjs');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], '1.30.1');
  assert(script.includes('npm.cmd ci --omit=dev --ignore-scripts --prefix $payload'));
});
test('Relay staging and remote validation use the same explicit manifest', async () => {
  const source = await fs.readFile(path.join(root, 'scripts/deploy-rabilink-relay-windows.ps1'), 'utf8');
  assert(source.includes('foreach ($relative in $relayRuntimeFiles)'));
  assert(source.includes('$relayRuntimeLiteral = ($relayRuntimeFiles'));
  assert(source.includes('foreach (`$relative in `$runtimeFiles)'));
  assert(source.includes('Required Relay runtime module is missing'));
});
