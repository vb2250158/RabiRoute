import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { pairPc, parsePairingArguments } from './rabilink-pair-pc.mjs';
import { pairingHash } from './rabilink-pc-pairing.mjs';
import { WebSocket } from 'ws';
import { Script } from 'node:vm';

async function relayFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pairing-http-'));
  const port = await new Promise(resolve => { const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port; listener.close(() => resolve(port)); }); });
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.resolve('scripts/rabilink-relay-server.mjs')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, 'missing-webgui') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic += chunk; });
  t.after(async () => { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Fixture Relay exited: ' + diagnostic);
    try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, diagnostic);
  const json = async (pathname, { method = 'GET', cookie, token, body, csrf = false } = {}) => {
    const response = await fetch(base + pathname, { method, headers: { ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-rabilink-pairing-write': '1', origin: base } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, data: await response.json() };
  };
  const fixturePassword = randomUUID();
  const account = await json('/manage/api/accounts', { method: 'POST', body: { username: 'pairing-owner', password: fixturePassword } });
  const cookie = account.response.headers.get('set-cookie').split(';')[0];
  const created = await json('/manage/api/apps', { method: 'POST', cookie, body: { name: 'Pairing application' } });
  const issueTicket = async () => {
    const ticket = 'rpt_' + randomBytes(32).toString('base64url');
    const issuance = { id: randomUUID(), ticketHash: pairingHash(ticket) };
    const response = await json('/manage/api/apps/' + created.data.app.id + '/pc-pairing-tickets', { method: 'POST', cookie, csrf: true, body: issuance });
    assert.equal(response.response.status, 200);
    return { ticket, issuance, receipt: response.data.data };
  };
  return { base, directory, json, cookie, app: created.data.app, issueTicket };
}

test('real approval and CLI save register an independent PC, preserve configuration and revoke access', async t => {
  const f = await relayFixture(t);
  const stateRoot = path.join(f.directory, 'private-client'); fs.mkdirSync(path.join(stateRoot, 'data'), { recursive: true });
  const guid = randomUUID(), configFile = path.join(stateRoot, 'data', 'Config.json');
  const initial = { rabiGuid: guid, rabiName: 'Original instance', rabiLinkRelay: { enabled: false, deviceId: 'pairing-cloud', speechProxyEnabled: false }, unrelated: { preserve: ['route', 'settings'] } };
  fs.writeFileSync(configFile, JSON.stringify(initial));
  const printed = [];
  const enrollment = await f.issueTicket();
  const result = await pairPc({ ...parsePairingArguments(['--relay', f.base, '--state-root', stateRoot, '--name', 'Cloud PC']), ticket: enrollment.ticket }, {
    print(message) { printed.push(message); }
  });
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.rabiGuid, guid); assert.equal(saved.rabiName, 'Cloud PC');
  assert.deepEqual(saved.unrelated, initial.unrelated);
  assert.equal(saved.rabiLinkRelay.speechProxyEnabled, false); assert.equal(saved.rabiLinkRelay.enabled, true);
  assert.match(saved.rabiLinkRelay.token, /^rbw_/); assert.notEqual(saved.rabiLinkRelay.token, f.app.token);
  const params = new URLSearchParams({ deviceId: saved.rabiLinkRelay.deviceId, deviceGuid: guid, deviceName: 'Cloud PC', waitMs: '1', capabilities: 'webgui' });
  const registered = await f.json('/worker/tasks?' + params, { token: saved.rabiLinkRelay.token });
  assert.equal(registered.response.status, 200);
  const peers = await f.json('/api/rabilink/peers', { token: saved.rabiLinkRelay.token });
  assert.equal(peers.response.status, 200);
  assert.ok(JSON.stringify(peers.data).includes(guid));
  const impersonation = await f.json('/worker/tasks?' + new URLSearchParams({ deviceId: 'different-pc', deviceGuid: randomUUID(), waitMs: '1' }), { token: saved.rabiLinkRelay.token });
  assert.equal(impersonation.response.status, 403);
  const missingIdentity = await f.json('/worker/tasks?waitMs=1', { token: saved.rabiLinkRelay.token });
  assert.equal(missingIdentity.response.status, 403);
  const eventImpersonation = await f.json('/api/rabilink/events?deviceName=different-pc', { token: saved.rabiLinkRelay.token });
  assert.equal(eventImpersonation.response.status, 403);
  const accountState = await f.json('/manage/api/state', { cookie: f.cookie });
  assert.equal(accountState.data.apps[0].pcCredentials.length, 1);
  assert.equal('token' in accountState.data.apps[0], false);
  const integrationState = await f.json('/manage/api/state?integration=1', { cookie: f.cookie });
  assert.equal(integrationState.data.apps[0].token, f.app.token);
  assert.ok(!JSON.stringify(accountState.data).includes(saved.rabiLinkRelay.token));
  assert.equal('ticket' in JSON.parse(fs.readFileSync(path.join(stateRoot, 'data', 'pc-pairing-request.json'), 'utf8')), false);
  const beforeRepeat = fs.readFileSync(configFile, 'utf8');
  await pairPc(parsePairingArguments(['--relay', f.base, '--state-root', stateRoot]), { print: message => printed.push(message) });
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeRepeat);
  const eventResponse = await fetch(f.base + '/api/rabilink/events?' + params, { headers: { authorization: 'Bearer ' + saved.rabiLinkRelay.token } });
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader(); await reader.read();
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + '/api/rabilink/tunnel/socket?room=' + randomUUID(),
    { headers: { authorization: 'Bearer ' + saved.rabiLinkRelay.token } });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  const revoked = await f.json('/manage/api/apps/' + f.app.id + '/pc-credentials/' + result.credentialId,
    { method: 'DELETE', cookie: f.cookie, csrf: true, body: {} });
  assert.equal(revoked.response.status, 200);
  await Promise.race([socketClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('Revoked tunnel stayed open')), 2_000))]);
  await Promise.race([(async () => { while (!(await reader.read()).done) {} })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Revoked event stream stayed open')), 2_000))]);
  assert.equal((await f.json('/api/rabilink/peers', { token: saved.rabiLinkRelay.token })).response.status, 401);
  await assert.rejects(pairPc(parsePairingArguments(['--relay', f.base, '--state-root', stateRoot]), { print: () => {} }), /revoked/);
  const logs = fs.readFileSync(path.join(f.directory, 'events.jsonl'), 'utf8');
  const serverStore = fs.readFileSync(path.join(f.directory, 'apps.json'), 'utf8');
  const pending = JSON.parse(fs.readFileSync(path.join(stateRoot, 'data', 'pc-pairing-request.json'), 'utf8'));
  for (const secret of [saved.rabiLinkRelay.token, pending.proof, enrollment.ticket]) {
    assert.ok(!logs.includes(secret)); assert.ok(!serverStore.includes(secret)); assert.ok(!printed.join('\n').includes(secret));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateRoot, 'data', '.pc-pairing-config-backup-' + pending.request.id + '.json'), 'utf8')), initial);
  if (process.platform !== 'win32') assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  const newEnrollment = await f.issueTicket();
  await pairPc({ ...parsePairingArguments(['--relay', f.base, '--state-root', stateRoot, '--new-request']), ticket: newEnrollment.ticket }, { print() {} });
  const renewed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.notEqual(renewed.rabiLinkRelay.token, saved.rabiLinkRelay.token);
  assert.equal(renewed.rabiGuid, saved.rabiGuid);
});

test('only authenticated console issuance can enroll a PC; replay and query-string secrets are rejected', async t => {
  const f = await relayFixture(t);
  const enrollment = await f.issueTicket();
  const request = { id: randomUUID(), deviceId: 'new-pc', deviceGuid: randomUUID(), deviceName: 'New PC',
    proofHash: pairingHash('rpp_' + randomBytes(32).toString('base64url')), credentialHash: pairingHash('rbw_' + randomBytes(32).toString('base64url')) };
  const issueRoute = '/manage/api/apps/' + f.app.id + '/pc-pairing-tickets';
  assert.equal((await f.json(issueRoute, { method: 'POST', body: enrollment.issuance, csrf: true })).response.status, 401);
  assert.equal((await f.json(issueRoute, { method: 'POST', cookie: f.cookie, body: enrollment.issuance })).response.status, 403);
  assert.equal((await f.json('/api/rabilink/pc-pairings', { method: 'POST', body: request })).response.status, 401);
  assert.equal((await f.json('/api/rabilink/pc-pairings?token=' + enrollment.ticket, { method: 'POST', body: request })).response.status, 401);
  const begun = await f.json('/api/rabilink/pc-pairings', { method: 'POST', token: enrollment.ticket, body: request });
  assert.equal(begun.response.status, 200);
  assert.equal((await f.json('/api/rabilink/pc-pairings', { method: 'POST', token: enrollment.ticket, body: { ...request, id: randomUUID() } })).response.status, 409);
  assert.equal((await f.json('/api/rabilink/pc-pairings/' + request.id + '/receipt', { method: 'POST' })).response.status, 401);
  const repeated = await f.json(issueRoute, { method: 'POST', cookie: f.cookie, csrf: true, body: enrollment.issuance });
  assert.equal(repeated.data.data.consumed, true);
  assert.ok(!JSON.stringify(repeated.data).includes(enrollment.ticket));
  const html = await (await fetch(f.base + '/manage')).text();
  assert.ok(html.includes('复制接入提示词') && html.includes('const integrationMode = false'));
  assert.ok(!html.includes('pcPairingApprove') && !html.includes('pcPairingInspect') && !html.includes('pcPairingApp'));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
  const integrationHtml = await (await fetch(f.base + '/manage?integration=1')).text();
  assert.ok(integrationHtml.includes('const integrationMode = true'));
  for (const file of enrollment.receipt.files) {
    const download = await fetch(f.base + '/api/rabilink/pc-pairings/client/' + file.name);
    assert.equal(download.status, 200);
    const source = Buffer.from(await download.arrayBuffer());
    assert.equal(source.length, file.size); assert.equal(pairingHash(source), file.sha256);
    assert.equal(download.headers.get('x-rabilink-content-sha256'), file.sha256);
  }
});

test('an interrupted enrollment resumes its original receipt instead of consuming a second code', async t => {
  const f = await relayFixture(t), enrollment = await f.issueTicket();
  const stateRoot = path.join(f.directory, 'interrupted-client'); fs.mkdirSync(path.join(stateRoot, 'data'), { recursive: true });
  const file = path.join(stateRoot, 'data', 'Config.json');
  fs.writeFileSync(file, JSON.stringify({ rabiGuid: randomUUID(), rabiLinkRelay: { enabled: false } }));
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(pairPc({ relay: f.base, stateRoot, ticket: enrollment.ticket }, { print() {}, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/api/rabilink/pc-pairings')) throw new TypeError('fixture lost response after commit');
    return response;
  } }), /lost response/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await pairPc({ relay: f.base, stateRoot }, { print() {} });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rabiLinkRelay.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'apps.json'), 'utf8')).apps[0].pcCredentials.length, 1);
});

test('the real CLI consumes the one-time code from stdin without printing it', async t => {
  const f = await relayFixture(t), enrollment = await f.issueTicket();
  const stateRoot = path.join(f.directory, 'stdin-client'); fs.mkdirSync(path.join(stateRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'data', 'Config.json'), JSON.stringify({ rabiGuid: randomUUID(), rabiLinkRelay: { enabled: false } }));
  const child = spawn(process.execPath, ['scripts/rabilink-pair-pc.mjs', '--relay', f.base, '--state-root', stateRoot, '--ticket-stdin']);
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end(enrollment.ticket + '\n');
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, output);
  const saved = JSON.parse(fs.readFileSync(path.join(stateRoot, 'data', 'Config.json'), 'utf8'));
  assert.match(saved.rabiLinkRelay.token, /^rbw_/);
  assert.ok(!output.includes(enrollment.ticket) && !output.includes(saved.rabiLinkRelay.token));
});

test('CLI rejects plaintext public URLs and never emits damaged private JSON', async () => {
  assert.throws(() => parsePairingArguments(['--relay', 'http://relay.example.com', '--state-root', path.resolve('private')]), /HTTPS/);
  assert.throws(() => parsePairingArguments(['--relay', 'https://relay.example.com?token=fixture', '--state-root', path.resolve('private')]), /HTTPS/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pairing-private-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'Config.json'), '{"secret":"fixture-should-never-appear",');
    await assert.rejects(pairPc({ relay: 'https://relay.example.com', stateRoot: root }, { print() {} }), error => error.message === '私有配置格式无效，保留原文件。');
    assert.ok(!fs.existsSync(path.join(root, 'data', 'pc-pairing.lock')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
