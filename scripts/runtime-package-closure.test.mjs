import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('Windows PowerShell prepares the real runtime manifest as individual scalar paths', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const script = path.join(root, 'scripts/deploy-rabilink-relay-windows.ps1').replaceAll("'", "''");
  const command = `$prepared = & '${script}' -RuntimeOnly -PrepareOnly -ServerIp stage.invalid -Domain stage.invalid; $prepared | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 25000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout.trim());
  assert.equal(prepared.Prepared, true); assert.equal(prepared.RuntimeOnly, true);
  const files = JSON.parse(await fs.readFile(path.join(prepared.BundleRoot, 'scripts/rabilink-relay-runtime-files.json'), 'utf8'));
  assert.deepEqual(files, JSON.parse(await fs.readFile(path.join(root, 'scripts/rabilink-relay-runtime-files.json'), 'utf8')));
  for (const file of files) assert.equal((await fs.stat(path.join(prepared.BundleRoot, file))).isFile(), true);
});
async function closure(entry, available) {
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    assert(available.has(file), `Missing runtime module: ${file}`);
    visited.add(file);
    assert.match(file, /^(scripts\/(lib\/)?[a-z0-9-]+|packages\/(rabi-knowledge-contract\/(schema|tools|receipt)|rabi-api-contract\/request|rabilink-agent-contract\/(profile|state|persona)))\.mjs$/);
    const source = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert(!next.startsWith('../') && !path.posix.isAbsolute(next), 'Runtime dependency escapes repository');
      await visit(next);
    }
  }
  await visit(entry);
  return visited;
}
test('Relay manifest includes imports and its actually served pairing client', async () => {
  const files = JSON.parse(await fs.readFile(path.join(root, 'scripts/rabilink-relay-runtime-files.json'), 'utf8'));
  assert.equal(new Set(files).size, files.length);
  const found = await closure('scripts/rabilink-relay-server.mjs', new Set(files));
  const server = await fs.readFile(path.join(root, 'scripts/rabilink-relay-server.mjs'), 'utf8');
  assert(server.includes("'/api/rabilink/pc-pairings/client/rabilink-pair-pc.mjs': 'rabilink-pair-pc.mjs'"));
  for (const file of await closure('scripts/rabilink-pair-pc.mjs', new Set(files))) found.add(file);
  assert.deepEqual([...found].sort(), files.slice().sort());
  const missing = new Set(files); missing.delete('scripts/lib/rabilink-tunnel-broker.mjs');
  await assert.rejects(closure('scripts/rabilink-relay-server.mjs', missing), /Missing runtime module/);
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
  assert(script.includes('$requiredPortableRuntimeFiles += $relative'));
  assert(script.includes("Get-Content -LiteralPath (Join-Path $repo 'scripts/rabilink-relay-runtime-files.json')"));
  const mcpTools = await fs.readFile(path.join(root, 'apps/rabi-mcp/lib/knowledge-tools.mjs'), 'utf8');
  assert(mcpTools.includes('../../../packages/rabi-knowledge-contract/tools.mjs'));
  assert.equal(path.posix.normalize('apps/rabi-mcp/lib/../../../packages/rabi-knowledge-contract/tools.mjs'), 'packages/rabi-knowledge-contract/tools.mjs');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.match(pkg.dependencies['@modelcontextprotocol/sdk'], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], lock.packages['node_modules/@modelcontextprotocol/sdk'].version);
  assert(script.includes('npm.cmd ci --omit=dev --ignore-scripts --prefix $payload'));
});
test('PC owner contracts have an independent portable closure and load without Relay files', async () => {
  const script = await fs.readFile(path.join(root, 'scripts/build-windows-release.ps1'), 'utf8');
  const required = new Set([...script.match(/\$requiredPortableRuntimeFiles = @\(([\s\S]*?)\r?\n\)/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]));
  const contracts = new Set();
  for (const owner of ['src/manager/rabiLinkAgentDevices.ts', 'src/manager/rabiLinkMobileOwner.ts', 'src/peerTunnel/http.ts']) {
    const source = await fs.readFile(path.join(root, owner), 'utf8');
    for (const match of source.matchAll(/from\s*['"](\.\.\/\.\.\/(?:packages|scripts)\/[^'"]+\.mjs)['"]/g)) {
      const contract = path.posix.normalize(path.posix.join(path.posix.dirname(owner), match[1]));
      assert(required.has(contract), `PC owner dependency must be explicit, independent of Relay: ${contract}`);
      for (const file of await closure(contract, required)) contracts.add(file);
    }
  }
  for (const file of ['packages/rabi-knowledge-contract/schema.mjs', 'packages/rabi-knowledge-contract/tools.mjs', 'packages/rabi-knowledge-contract/receipt.mjs']) {
    assert(required.has(file)); for (const dependency of await closure(file, required)) contracts.add(dependency);
  }
  assert.equal(required.has('scripts/rabilink-knowledge-operations.mjs'), false);
  assert.equal(required.has('packages/rabilink-agent-contract/request-csrf.mjs'), false);
  assert.deepEqual([...contracts].sort(), ['packages/rabi-api-contract/request.mjs', 'packages/rabi-knowledge-contract/receipt.mjs', 'packages/rabi-knowledge-contract/schema.mjs', 'packages/rabi-knowledge-contract/tools.mjs', 'packages/rabilink-agent-contract/persona.mjs', 'packages/rabilink-agent-contract/profile.mjs', 'packages/rabilink-agent-contract/state.mjs']);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-owner-runtime-layout-'));
  try {
    for (const file of contracts) {
      const destination = path.join(directory, file); await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(root, file), destination);
    }
    for (const [file, exported] of [['packages/rabi-api-contract/request.mjs', 'validateApiRequest'], ['packages/rabilink-agent-contract/profile.mjs', 'createAgentProfileService'], ['packages/rabilink-agent-contract/state.mjs', 'normalizeAgentProfileState'], ['packages/rabilink-agent-contract/persona.mjs', 'readAiuiPersonaTemplate']]) {
      const module = await import(pathToFileURL(path.join(directory, file)).href);
      assert.equal(typeof module[exported], 'function');
    }
    const tools = await import(pathToFileURL(path.join(directory, 'packages/rabi-knowledge-contract/tools.mjs')).href);
    assert.equal(typeof tools.createKnowledgeTools, 'function');
    await assert.rejects(fs.access(path.join(directory, 'scripts/rabilink-relay-server.mjs')), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('Relay staging and remote validation use the same explicit manifest', async () => {
  const source = await fs.readFile(path.join(root, 'scripts/deploy-rabilink-relay-windows.ps1'), 'utf8');
  assert(source.includes('foreach ($relative in $relayRuntimeFiles)'));
  assert(source.includes('$relayRuntimeLiteral = ($relayRuntimeFiles'));
  assert(source.includes('foreach (`$relative in `$runtimeFiles)'));
  assert(source.includes('Required Relay runtime module is missing'));
  assert(source.includes('"start": "node scripts/rabilink-relay-server.mjs"'));
  assert(source.includes('node "$RemoteRoot\\scripts\\rabilink-relay-server.mjs"'));
  assert(source.indexOf('Remove-LegacyRelayRuntimeLayout -Root `$remoteRoot') > source.indexOf('Unregister-ScheduledTask -TaskName `$taskName'));
  assert(source.includes("'logs/relay-layout-migration.json'"));
});

test('staged repo-layout Relay imports its shared contract and actually serves health', { timeout: 15000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-runtime-layout-'));
  let child;
  try {
    const files = JSON.parse(await fs.readFile(path.join(root, 'scripts/rabilink-relay-runtime-files.json'), 'utf8'));
    for (const relative of files) {
      const destination = path.join(directory, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(root, relative), destination);
    }
    await fs.cp(path.join(root, 'node_modules/ws'), path.join(directory, 'node_modules/ws'), { recursive: true });
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    let output = '';
    child = spawn(process.execPath, ['scripts/rabilink-relay-server.mjs'], {
      cwd: directory, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RABILINK_RELAY_DATA_DIR: path.join(directory, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) { health = await response.json(); break; } } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(health?.ok, true, output);
    for (const file of ['scripts/rabilink-knowledge-grant.mjs', 'scripts/rabilink-knowledge-grant-ui.mjs', 'rabilink-relay-server.mjs']) {
      await assert.rejects(fs.access(path.join(directory, file)), { code: 'ENOENT' });
    }
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('next Windows deploy backs up then retires the old flat runtime without removing data or unrelated scripts', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-layout-migration-'));
  const service = path.join(directory, 'service'), backup = path.join(service, 'backups/code-fixture');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const source = await fs.readFile(path.join(root, 'scripts/deploy-rabilink-relay-windows.ps1'), 'utf8');
  const functions = source.match(/\$relayLayoutFunctions = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert(functions, 'Actual deployment migration functions must be testable without SSH.');
  async function write(relative, content) { const target = path.join(service, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
  try {
    await write('rabilink-relay-runtime-files.json', JSON.stringify(['rabilink-relay-server.mjs', 'rabilink-knowledge-grant.mjs', 'lib/rabilink-tunnel-broker.mjs']));
    const oldModules = ['rabilink-relay-server.mjs', 'rabilink-knowledge-grant.mjs', 'rabilink-knowledge-grant-ui.mjs', 'lib/rabilink-tunnel-broker.mjs', 'scripts/rabilink-knowledge-grant.mjs', 'scripts/rabilink-knowledge-grant-ui.mjs'];
    for (const relative of oldModules) await write(relative, 'old code');
    await write('scripts/rabilink-relay-server.mjs', 'new code');
    await write('scripts/rabilink-relay-runtime-files.json', JSON.stringify(['scripts/rabilink-relay-server.mjs']));
    await write('data/apps.json', 'private data preserved');
    await write('scripts/local-maintenance.ps1', 'preserved');
    const command = `$ErrorActionPreference='Stop'\n${functions}\n$root=${quote(service)}\n$backup=${quote(backup)}\n$runtime=@('scripts/rabilink-relay-server.mjs','scripts/lib/rabilink-tunnel-broker.mjs')\n$legacy=@(Get-LegacyRelayRuntimeFiles -Root $root -RuntimeFiles $runtime)\nBackup-RelayRuntimeLayout -Root $root -BackupRoot $backup -Files ($legacy+@('rabilink-relay-runtime-files.json','scripts/rabilink-knowledge-grant.mjs','scripts/rabilink-knowledge-grant-ui.mjs'))\n$removed=@(Remove-LegacyRelayRuntimeLayout -Root $root -LegacyFiles $legacy)\ntry { Remove-LegacyRelayRuntimeLayout -Root $root -LegacyFiles @('../outside.mjs'); throw 'escape allowed' } catch { if ($_.Exception.Message -eq 'escape allowed') { throw } }\n$again=@(Remove-LegacyRelayRuntimeLayout -Root $root -LegacyFiles $legacy)\nif ($removed.Count -ne 6 -or $again.Count -ne 0) { throw 'Migration is not complete or idempotent' }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const relative of [...oldModules, 'rabilink-relay-runtime-files.json']) {
      await assert.rejects(fs.access(path.join(service, relative)), { code: 'ENOENT' });
      assert.ok(await fs.readFile(path.join(backup, relative), 'utf8'));
    }
    assert.equal(await fs.readFile(path.join(service, 'scripts/rabilink-relay-server.mjs'), 'utf8'), 'new code');
    assert.equal(await fs.readFile(path.join(service, 'data/apps.json'), 'utf8'), 'private data preserved');
    assert.equal(await fs.readFile(path.join(service, 'scripts/local-maintenance.ps1'), 'utf8'), 'preserved');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('repo-layout retirement backs up its whole old closure and private bytes, then rolls code back without reverting live data', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-repo-retirement-'));
  const service = path.join(directory, 'service'), backup = path.join(service, 'backups/code-fixture');
  const source = await fs.readFile(path.join(root, 'scripts/deploy-rabilink-relay-windows.ps1'), 'utf8');
  const functions = source.match(/\$relayLayoutFunctions = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert(functions);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const retired = ['scripts/rabilink-agent-profile.mjs', 'scripts/rabilink-profile-mcp-editor.mjs', 'scripts/rabilink-knowledge-access.mjs', 'packages/rabilink-agent-contract/request-csrf.mjs', 'packages/rabi-knowledge-contract/tools.mjs', 'scripts/previous-extra-runtime.mjs'];
  const write = async (relative, content) => { const file = path.join(service, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  try {
    const oldManifest = JSON.stringify(['scripts/rabilink-relay-server.mjs', ...retired]);
    await write('scripts/rabilink-relay-runtime-files.json', oldManifest);
    await write('scripts/rabilink-relay-server.mjs', 'old entry');
    for (const file of retired) await write(file, 'retired ' + file);
    await write('scripts/unrelated-runtime.mjs', 'unrelated code');
    await write('data/apps.json', '{"unknown":{"kept":true},"taskId":"original-id"}');
    await write('data/arbitrary-extension/binary.dat', Buffer.from([0, 255, 17, 13]));
    const command = `$ErrorActionPreference='Stop'\n${functions}\n$root=${quote(service)}\n$backup=${quote(backup)}\n$runtime=@('scripts/rabilink-relay-server.mjs','scripts/rabilink-device-api.mjs')\n$legacy=@(Get-LegacyRelayRuntimeFiles -Root $root -RuntimeFiles $runtime)\n$files=@($runtime+$legacy+@('scripts/rabilink-relay-runtime-files.json'))\nBackup-RelayPrivateState -Root $root -BackupRoot $backup\nBackup-RelayRuntimeLayout -Root $root -BackupRoot $backup -Files $files\n$layout=@{version=1;files=@();absent=@()}\nforeach($relative in ($files|Sort-Object -Unique)) { $file=Resolve-RelayLayoutPath -Root $root -Relative $relative; if(Test-Path -LiteralPath $file -PathType Leaf){$layout.files+=@{path=$relative;sha256=(Get-RelayFileHash -LiteralPath $file).Hash}}else{$layout.absent+=$relative}}\n$layout|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $backup 'code-layout.json') -Encoding UTF8\nRemove-LegacyRelayRuntimeLayout -Root $root -LegacyFiles $legacy|Out-Null\nSet-Content -LiteralPath (Join-Path $root 'scripts/rabilink-relay-server.mjs') -Value 'new entry'\nSet-Content -LiteralPath (Join-Path $root 'scripts/rabilink-device-api.mjs') -Value 'new module'\nSet-Content -LiteralPath (Join-Path $root 'data/apps.json') -Value 'live state after deployment'\nRestore-RelayRuntimeLayout -Root $root -BackupRoot $backup`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const file of retired) assert.equal(await fs.readFile(path.join(service, file), 'utf8'), 'retired ' + file);
    assert.equal(await fs.readFile(path.join(service, 'scripts/rabilink-relay-server.mjs'), 'utf8'), 'old entry');
    assert.equal(await fs.readFile(path.join(service, 'scripts/rabilink-relay-runtime-files.json'), 'utf8'), oldManifest);
    await assert.rejects(fs.access(path.join(service, 'scripts/rabilink-device-api.mjs')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(service, 'scripts/unrelated-runtime.mjs'), 'utf8'), 'unrelated code');
    assert.match(await fs.readFile(path.join(service, 'data/apps.json'), 'utf8'), /live state after deployment/);
    assert.equal(await fs.readFile(path.join(backup, 'data/apps.json'), 'utf8'), '{"unknown":{"kept":true},"taskId":"original-id"}');
    assert.deepEqual(await fs.readFile(path.join(backup, 'data/arbitrary-extension/binary.dat')), Buffer.from([0, 255, 17, 13]));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
