import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const root = process.env.RABI_PORT_CANDIDATE ?? fileURLToPath(new URL("..", import.meta.url));
const { discoverSpeechServiceUrl } = await import(pathToFileURL(path.join(root, 'scripts/lib/discover-speech-url.mjs')));
const python = process.env.RABIROUTE_TEST_PYTHON || 'python';
const hasPython = spawnSync(python, ['--version'], { windowsHide: true }).status === 0;
function child(command, args, env = {}) { return new Promise((resolve, reject) => { const p = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true }); let stdout = '', stderr = ''; p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d); const timer = setTimeout(() => p.kill(), 20000); p.on('error', reject); p.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); }); }
async function fixture(action) { const requests = []; let baseUrl = ''; const server = http.createServer(async (req, res) => { let body = ''; for await (const chunk of req)
    body += chunk; requests.push({ url: req.url, body }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(action?.(req, body, baseUrl) ?? { ok: true })); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`; return { baseUrl, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) }; }
const identity = { managerBaseUrl: 'http://127.0.0.1:42111', applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-instance' };
test('Speech owner resolution rechecks Manager identity and accepts dynamic loopback URL', async () => { let checks = 0; assert.equal(await discoverSpeechServiceUrl({ discoverManagerIdentity: async () => { checks++; return identity; }, fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: { state: 'online', configuredUrl: 'http://127.0.0.1:51234' } }) }) }), 'http://127.0.0.1:51234'); assert.equal(checks, 2); });
test('Speech explicit URL is retained without Manager discovery', async () => { assert.equal(await discoverSpeechServiceUrl({ explicit: 'https://speech.example.invalid/base/', discoverManagerIdentity: async () => { throw Error('unexpected'); } }), 'https://speech.example.invalid/base'); });
test('Speech discovery rejects offline, peer, zero, credential and nonlocal publications', async () => { for (const data of [{ state: 'offline', configuredUrl: '' }, { state: 'online', configuredUrl: 'peer:fixture' }, { state: 'online', configuredUrl: 'http://127.0.0.1:0' }, { state: 'online', configuredUrl: 'http://user:secret@127.0.0.1:51234' }, { state: 'online', configuredUrl: 'https://remote.example.invalid' }])
    await assert.rejects(discoverSpeechServiceUrl({ discoverManagerIdentity: async () => identity, fetch: async () => ({ ok: true, json: async () => ({ code: 0, data }) }) })); });
test('Speech discovery rejects identity rotation and HTTP errors', async () => { let count = 0; await assert.rejects(discoverSpeechServiceUrl({ discoverManagerIdentity: async () => ({ ...identity, managerInstanceId: String(count++) }), fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: { state: 'online', configuredUrl: 'http://127.0.0.1:51234' } }) }) }), /identity changed/); await assert.rejects(discoverSpeechServiceUrl({ discoverManagerIdentity: async () => identity, fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/); });
test('Webhook and OneBot require explicit targets before sending', { skip: !hasPython }, async () => { for (const [command, args] of [[process.execPath, ['examples/send-webhook-demo.mjs']], [python, ['examples/send-webhook-demo.py']], [process.execPath, ['scripts/send-onebot-message.mjs', '--group', 'fixture', '--message', 'fixture']]]) {
    const result = await child(command, args, { RABIROUTE_WEBHOOK_URL: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /URL is required/);
} });
test('Explicit Node/Python webhook targets receive only fixture messages', { skip: !hasPython }, async () => { const f = await fixture(); try {
    for (const [command, args, env] of [[process.execPath, ['examples/send-webhook-demo.mjs', f.baseUrl + '/webhook', 'fixture'], {}], [python, ['examples/send-webhook-demo.py', f.baseUrl + '/webhook', 'fixture'], {}], [python, ['examples/send-webhook-demo.py'], { RABIROUTE_WEBHOOK_URL: f.baseUrl + '/webhook' }]]) {
        const result = await child(command, args, env);
        assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(f.requests.length, 3);
    assert.ok(f.requests.every(r => r.url === '/webhook' && JSON.parse(r.body).type === 'webhook.text'));
}
finally {
    await f.close();
} });
test('Explicit OneBot target retains action, token and newline payload', async () => { let auth = ''; const f = await fixture(req => { auth = req.headers.authorization; return { status: 'ok' }; }); try {
    const result = await child(process.execPath, ['scripts/send-onebot-message.mjs', '--url', f.baseUrl, '--token', 'fixture-token', '--user', 'fixture-account', '--message', 'one\\ntwo']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(auth, 'Bearer fixture-token');
    assert.deepEqual(f.requests.map(r => [r.url, JSON.parse(r.body)]), [['/send_private_msg', { user_id: 'fixture-account', message: 'one\ntwo' }]]);
}
finally {
    await f.close();
} });
test('Speech CLI and PowerShell bridge use current Manager publication for every observation', { skip: process.platform !== 'win32' }, async () => { let lookups = 0; const f = await fixture((req, _body, baseUrl) => req.url === '/meta' ? { ...identity, managerBaseUrl: baseUrl, health: { live: true, state: 'degraded' } } : { code: 0, data: { state: 'online', configuredUrl: `http://127.0.0.1:${52000 + (lookups++)}` } }); try {
    const result = await child(process.execPath, ['scripts/resolve-speech.mjs'], { RABIROUTE_MANAGER_URL: f.baseUrl });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'http://127.0.0.1:52000');
    const ps = await child('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ". './apps/rabi-mobile-android/scripts/Resolve-RabiSpeechEndpoint.ps1'; Resolve-RabiSpeechEndpoint; Resolve-RabiSpeechEndpoint; Resolve-RabiSpeechEndpoint -ExplicitUrl 'https://explicit.example.invalid/base/'"], { RABIROUTE_MANAGER_URL: f.baseUrl });
    assert.equal(ps.code, 0, ps.stderr);
    assert.deepEqual(ps.stdout.trim().split(/\r?\n/), ['http://127.0.0.1:52001', 'http://127.0.0.1:52002', 'https://explicit.example.invalid/base']);
    assert.equal(f.requests.filter(r => r.url === '/meta').length, 6);
}
finally {
    await f.close();
} });
test('Mobile scripts parse with default dynamic consumer expression', { skip: process.platform !== 'win32' }, async () => { const result = await child('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$names=@('Test-RabiMobileAudioSoak.ps1','Test-RabiMobileDurableAudioSoak.ps1','Test-RabiMobileDurableAudioFaults.ps1'); foreach($name in $names){$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD ('apps/rabi-mobile-android/scripts/'+$name)),[ref]$null,[ref]$errors)|Out-Null;if($errors){throw ($errors|Out-String)}}"]); assert.equal(result.code, 0, result.stderr); });
