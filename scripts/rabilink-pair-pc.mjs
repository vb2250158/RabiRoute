#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pairingHash, pairingFingerprint } from './rabilink-pc-pairing.mjs';

function readPrivateJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('私有配置格式无效，保留原文件。'); }
}

const privateWrite = (file, value) => {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
};

export function parsePairingArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    if (args[i] === '--new-request') { options.newRequest = true; continue; }
    if (args[i] === '--ticket-stdin') { options.ticketStdin = true; continue; }
    if (!['--relay', '--state-root', '--name'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('参数只支持 --relay、--state-root、--name、--ticket-stdin 和 --new-request。');
    options[args[i].slice(2)] = args[++i];
  }
  if (!options['state-root'] || !path.isAbsolute(options['state-root'])) throw new Error('--state-root 必须指定实例的绝对运行目录。');
  let relay;
  try { relay = new URL(options.relay); } catch { throw new Error('--relay 必须指定完整服务器地址。'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(relay.hostname);
  if ((relay.protocol !== 'https:' && !(loopback && relay.protocol === 'http:')) || relay.username || relay.password
      || relay.search || relay.hash || !['', '/'].includes(relay.pathname)) throw new Error('公网服务器必须使用不含凭据的 HTTPS 根地址。');
  return { relay: relay.origin, stateRoot: path.resolve(options['state-root']), name: options.name, newRequest: options.newRequest === true, ticketStdin: options.ticketStdin === true };
}

function newPending(relay, identity, ticket) {
  if (!/^rpt_[A-Za-z0-9_-]{43}$/.test(ticket || '')) throw new Error('需要有效的一次性接入码；从控制台复制接入提示词，通过标准输入提供接入码。');
  const proof = 'rpp_' + randomBytes(32).toString('base64url'), credential = 'rbw_' + randomBytes(32).toString('base64url');
  return { relay, proof, credential, ticket, request: { id: randomUUID(), ...identity,
    proofHash: pairingHash(proof), credentialHash: pairingHash(credential) } };
}

function assertPrivateRuntime(dataDirectory) {
  // A checkout is supported only when runtime files are ignored and untracked.
  let ancestor = dataDirectory, repository = false;
  while (true) {
    if (fs.existsSync(path.join(ancestor, '.git'))) { repository = true; break; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!repository) return;
  try { execFileSync('git', ['-C', dataDirectory, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' }); }
  catch { throw new Error('无法核对仓库运行配置的私有归属，拒绝保存凭据。'); }
  for (const file of ['Config.json', 'pc-pairing-request.json']) {
    if (execFileSync('git', ['-C', dataDirectory, 'ls-files', '--', file], { encoding: 'utf8', stdio: 'pipe' }).trim())
      throw new Error('运行配置已被 Git 跟踪，拒绝保存凭据。');
    try { execFileSync('git', ['-C', dataDirectory, 'check-ignore', '--quiet', '--', file], { stdio: 'pipe' }); }
    catch { throw new Error('运行配置未被 Git 忽略，拒绝保存凭据。'); }
  }
}

async function api(relay, pathname, body, proof, fetchImpl, signal) {
  const response = await fetchImpl(relay + pathname, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(proof ? { authorization: 'Bearer ' + proof } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal });
  let result;
  try { result = await response.json(); } catch { throw new Error('配对服务器返回了无法解析的响应。'); }
  if (!response.ok || result.code !== 0 || !result.data) {
    const code = typeof result.code === 'string' && /^PAIRING_[A-Z_]+$/.test(result.code) ? result.code : 'PAIRING_HTTP_' + response.status;
    throw Object.assign(new Error(code), { statusCode: response.status, code });
  }
  return result.data;
}

/** Long-term secrets are generated here; the one-time ticket is never printed. */
export async function pairPc(options, { fetchImpl = fetch, print = console.log, signal } = {}) {
  const dataDirectory = path.join(options.stateRoot, 'data');
  const configFile = path.join(dataDirectory, 'Config.json');
  const pendingFile = path.join(dataDirectory, 'pc-pairing-request.json');
  if (!fs.existsSync(configFile)) throw new Error('实例配置不存在。先通过现有 Host 初始化独立实例。');
  assertPrivateRuntime(dataDirectory);
  const lockFile = path.join(dataDirectory, 'pc-pairing.lock');
  let lock;
  try { lock = fs.openSync(lockFile, 'wx', 0o600); }
  catch { throw new Error('另一配对命令正在运行；确认它已退出后再移除 pc-pairing.lock。'); }
  try {
    const config = readPrivateJson(configFile);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(config.rabiGuid || ''))
      throw new Error('实例标识无效，请先通过原 Host 初始化独立身份。');
    const identity = { deviceId: config.rabiLinkRelay?.deviceId || 'pc-' + config.rabiGuid,
      deviceGuid: config.rabiGuid, deviceName: options.name || config.rabiName || 'Cloud PC' };
    let pending;
    if (fs.existsSync(pendingFile)) {
      pending = readPrivateJson(pendingFile);
      if (pending.relay !== options.relay || pending.request.deviceGuid !== identity.deviceGuid || pending.request.deviceId !== identity.deviceId)
        throw new Error('已有其他服务器或设备的配对记录，请先处理该记录。');
    } else {
      pending = newPending(options.relay, identity, options.ticket);
      // Persist before contacting Relay: an interrupted request resumes the same identity and proof.
      privateWrite(pendingFile, pending);
    }
    if (!/^rpp_[A-Za-z0-9_-]{43}$/.test(pending.proof || '') || !/^rbw_[A-Za-z0-9_-]{43}$/.test(pending.credential || '')
        || pairingHash(pending.proof) !== pending.request.proofHash || pairingHash(pending.credential) !== pending.request.credentialHash)
      throw new Error('配对记录校验失败，保留原文件。');
    const beginSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    let result;
    try { result = await api(options.relay, '/api/rabilink/pc-pairings/' + pending.request.id + '/receipt', undefined, pending.proof, fetchImpl, beginSignal); }
    catch (error) {
      if (error.statusCode !== 404) throw error;
      if (options.ticket && options.ticket !== pending.ticket) {
        privateWrite(path.join(dataDirectory, '.pc-pairing-request-backup-' + pending.request.id + '.json'), pending);
        pending.ticket = options.ticket; privateWrite(pendingFile, pending);
      }
      result = await api(options.relay, '/api/rabilink/pc-pairings', pending.request, pending.ticket, fetchImpl, beginSignal);
    }
    const validateReceipt = receipt => {
      if (receipt.id !== pending.request.id || receipt.fingerprint !== pairingFingerprint(pending.request)
          || !['approved', 'revoked'].includes(receipt.state))
        throw new Error('配对回执校验失败，保留原配置。');
    };
    validateReceipt(result);
    if (options.newRequest) {
      if (result.state !== 'revoked') throw new Error('原请求仍有效。保留原请求；已授权设备需先在控制台断开连接。');
      privateWrite(path.join(dataDirectory, '.pc-pairing-request-backup-' + pending.request.id + '.json'), pending);
      pending = newPending(options.relay, identity, options.ticket);
      privateWrite(pendingFile, pending);
      result = await api(options.relay, '/api/rabilink/pc-pairings', pending.request, pending.ticket, fetchImpl, beginSignal);
      validateReceipt(result);
    }
    if (pending.saved && result.state === 'approved') {
      if (config.rabiLinkRelay?.token !== pending.credential || config.rabiLinkRelay?.url !== options.relay)
        throw new Error('配对后配置已变化，拒绝覆盖。');
      print('该设备配对配置已保存。使用原 Host 启动或重启后验证上线。');
      return;
    }
    if (result.state !== 'approved') throw new Error('接入已撤销：revoked。重新复制提示词并在相同命令追加 --new-request。');
    if (result.id !== pending.request.id || result.deviceId !== pending.request.deviceId || result.deviceGuid !== pending.request.deviceGuid
        || !result.appId || result.credentialId !== 'pc-' + pending.request.id) throw new Error('配对回执身份不一致，拒绝保存。');
    const original = fs.readFileSync(configFile, 'utf8');
    const current = readPrivateJson(configFile);
    if (current.rabiGuid !== identity.deviceGuid || (current.rabiLinkRelay?.deviceId && current.rabiLinkRelay.deviceId !== identity.deviceId))
      throw new Error('实例身份已变化，拒绝应用旧配对。');
    const backup = path.join(dataDirectory, '.pc-pairing-config-backup-' + pending.request.id + '.json');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    const updated = { ...current, rabiName: pending.request.deviceName, rabiLinkRelay: { ...current.rabiLinkRelay,
      enabled: true, url: options.relay, deviceId: identity.deviceId, token: pending.credential } };
    if (fs.readFileSync(configFile, 'utf8') !== original) throw new Error('配置发生并发修改，保留原值，重新执行配对命令。');
    privateWrite(configFile, updated);
    const saved = readPrivateJson(configFile);
    if (JSON.stringify(saved) !== JSON.stringify(updated)) {
      privateWrite(configFile, current);
      throw new Error('配置回读不一致，已恢复原配置。');
    }
    pending.saved = { appId: result.appId, credentialId: result.credentialId };
    delete pending.ticket;
    privateWrite(pendingFile, pending);
    print('一次性接入已完成，配置已保存。使用原 Host 启动或重启后，确认控制台出现该设备。');
    return { appId: result.appId, deviceId: identity.deviceId, deviceGuid: identity.deviceGuid, credentialId: result.credentialId };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const options = parsePairingArguments(process.argv.slice(2));
    if (options.help) console.log('用法：node scripts/rabilink-pair-pc.mjs --relay https://relay.example.com --state-root /absolute/private/runtime --name "Cloud PC" --ticket-stdin');
    else {
      if (options.ticketStdin) {
        if (process.stdin.isTTY) throw new Error('接入码必须通过子进程标准输入传入，避免回显。');
        let input = '';
        for await (const chunk of process.stdin) {
          input += chunk.toString();
          if (input.length > 256) throw new Error('接入码输入无效。');
        }
        options.ticket = input.trim();
      }
      await pairPc(options, { signal: controller.signal });
    }
  } catch (error) {
    // Never echo upstream bodies, environment values or native filesystem error objects.
    console.error(error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? '配对请求中断；重新执行相同命令继续原请求。' : error.message);
    process.exitCode = 1;
  }
}
