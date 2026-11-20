import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findPcCredential, pairingHash } from './rabilink-pc-pairing.mjs';

export const isHostAccountScope = app => app?.kind === 'host-account-v1';
const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }

function validateDevice({ deviceId, deviceGuid, deviceName }) {
  if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(deviceId)
    || typeof deviceGuid !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(deviceGuid)
    || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 256 || /[\x00-\x1f\x7f]/.test(deviceName)) {
    fail(400, 'HOST_ACCOUNT_DEVICE_INVALID');
  }
  return { deviceId, deviceGuid, deviceName: deviceName.trim() };
}

export function createHostAccountService({ readStore, writeStore, createAccount, loginAccount, avatarDirectory }) {
  function result(account, legacyCompatible, receipt, token) {
    return { account: { id: account.id, username: account.username }, legacyCompatible, ...(receipt ? { receipt } : {}), ...(token ? { token } : {}) };
  }
  function activate(store, app, device, credentialHash, receipt) {
    const previous = app.pcCredentials.find(item => item.deviceGuid === device.deviceGuid);
    app.pcCredentials = app.pcCredentials.filter(item => item.deviceGuid !== device.deviceGuid);
    app.pcCredentials.push({ ...device, id: `pc-${device.deviceGuid}`, credentialHash, ...(receipt ? { hostAccountReceipt: receipt } : {}),
      appTokenHash: pairingHash(app.token), enabled: true, createdAt: new Date().toISOString() });
    if (app.hostAccountIssues) app.hostAccountIssues = app.hostAccountIssues.filter(item => item.deviceGuid !== device.deviceGuid);
    store.workers = store.workers.filter(item => item.appId !== app.id || item.guid !== device.deviceGuid || item.id === device.deviceId);
    writeStore(store);
    return previous ? { appId: app.id, targetDeviceId: previous.deviceGuid, peerId: previous.deviceId } : undefined;
  }
  function issue(account, device, legacyCompatible, attempt) {
    const store = readStore();
    let app = store.apps.find(item => isHostAccountScope(item) && item.ownerAccountId === account.id);
    if (!app) {
      app = { kind: 'host-account-v1', id: `hosts-${randomUUID()}`, ownerAccountId: account.id,
        token: randomBytes(32).toString('base64url'), enabled: true, pcCredentials: [], createdAt: new Date().toISOString() };
      store.apps.push(app);
    }
    if (app.enabled === false) fail(403, 'HOST_ACCOUNT_SCOPE_DISABLED');
    if (app.pcCredentials.some(item => item.enabled !== false && item.deviceId === device.deviceId && item.deviceGuid !== device.deviceGuid)) {
      fail(409, 'HOST_ACCOUNT_DEVICE_ID_IN_USE');
    }
    const previous = app.pcCredentials.find(item => item.deviceGuid === device.deviceGuid);
    if (attempt) {
      app.hostAccountIssues = (app.hostAccountIssues || []).filter(item => item.expiresAt > Date.now());
      if (app.hostAccountIssues.length >= 100 && !app.hostAccountIssues.some(item => item.deviceGuid === device.deviceGuid)) fail(429, 'HOST_ACCOUNT_ISSUE_BUSY');
      app.hostAccountIssues = app.hostAccountIssues.filter(item => item.deviceGuid !== device.deviceGuid);
      const receipt = { ...attempt, legacyCompatible, state: 'staged' };
      app.hostAccountIssues.push({ ...device, receipt, previousHash: previous?.credentialHash, expiresAt: Date.now() + 86400000 });
      writeStore(store);
      return { credentials: result(account, legacyCompatible, { requestId: attempt.requestId, state: 'staged' }) };
    }
    const token = `rbw_${randomBytes(32).toString('base64url')}`;
    const previousDevice = activate(store, app, device, pairingHash(token));
    return { previousDevice, credentials: result(account, legacyCompatible, undefined, token) };
  }
  function findIssue(store, requestId, credentialHash) {
    for (const app of store.apps) {
      if (!isHostAccountScope(app) || app.enabled === false) continue;
      const active = app.pcCredentials.find(item => item.enabled !== false && item.appTokenHash === pairingHash(app.token)
        && item.hostAccountReceipt?.requestId === requestId && item.credentialHash === credentialHash);
      const staged = app.hostAccountIssues?.find(item => item.expiresAt > Date.now()
        && item.receipt.requestId === requestId && item.receipt.credentialHash === credentialHash);
      const device = active || staged;
      if (device) return { app, device, receipt: active?.hostAccountReceipt || staged.receipt };
    }
  }
  function ownerAccount(store, token) {
    const match = findPcCredential(store, token);
    if (!match || !isHostAccountScope(match.app)) fail(401, 'HOST_ACCOUNT_AUTH_REQUIRED');
    const account = store.accounts.find(item => item.id === match.app.ownerAccountId);
    if (!account) fail(401, 'HOST_ACCOUNT_AUTH_REQUIRED');
    return { store, account };
  }
  return {
    profile(token, username) {
      const { store, account } = ownerAccount(readStore(), token);
      if (username === undefined) return { id: account.id, username: account.username };
      const name = typeof username === 'string' ? username.trim() : '';
      if (!/^[\p{L}\p{N}_@.-]{3,48}$/u.test(name)) fail(400, 'HOST_ACCOUNT_USERNAME_INVALID');
      if (store.accounts.some(item => item.id !== account.id && item.username.toLowerCase() === name.toLowerCase())) {
        fail(409, 'HOST_ACCOUNT_USERNAME_TAKEN');
      }
      if (account.username !== name) {
        account.username = name;
        account.updatedAt = new Date().toISOString();
        writeStore(store);
      }
      return { id: account.id, username: account.username };
    },
    avatar(token, image) {
      const store = readStore();
      const match = findPcCredential(store, token);
      if (!match || !isHostAccountScope(match.app)) fail(401, 'HOST_ACCOUNT_AUTH_REQUIRED');
      const account = store.accounts.find(item => item.id === match.app.ownerAccountId);
      if (!account) fail(401, 'HOST_ACCOUNT_AUTH_REQUIRED');
      const file = path.join(avatarDirectory, createHash('sha256').update(account.id).digest('hex') + '.png');
      if (image === undefined) {
        try { return readFileSync(file).toString('base64'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }
      if (typeof image !== 'string' || image.length > 175000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
        fail(400, 'HOST_ACCOUNT_AVATAR_INVALID');
      }
      const png = Buffer.from(image, 'base64');
      if (png.toString('base64') !== image || png.length < 33 || png.length > 131072
        || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
        || png.readUInt32BE(16) !== 160 || png.readUInt32BE(20) !== 160) {
        fail(400, 'HOST_ACCOUNT_AVATAR_INVALID');
      }
      mkdirSync(avatarDirectory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, png, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      } finally { rmSync(temporary, { force: true }); }
      return image;
    },
    authenticate(action, body, legacyToken) {
      const device = validateDevice(body || {});
      const requested = body.requestId !== undefined || body.credentialHash !== undefined;
      if (requested && (!requestIdPattern.test(body.requestId || '') || !/^[a-f0-9]{64}$/.test(body.credentialHash || ''))) fail(400, 'HOST_ACCOUNT_ISSUE_INVALID');
      const attempt = requested ? { requestId: body.requestId, credentialHash: body.credentialHash, action } : undefined;
      const store = readStore();
      const known = attempt && findIssue(store, attempt.requestId, attempt.credentialHash);
      if (attempt && !known && store.apps.some(app => isHostAccountScope(app) && (app.pcCredentials?.some(item => item.hostAccountReceipt?.requestId === attempt.requestId)
        || app.hostAccountIssues?.some(item => item.expiresAt > Date.now() && item.receipt.requestId === attempt.requestId)))) fail(409, 'HOST_ACCOUNT_ISSUE_CONFLICT');
      const complete = (account, legacyCompatible) => {
        if (!known) return issue(account, device, legacyCompatible, attempt);
        if (account.id !== known.app.ownerAccountId || known.device.deviceId !== device.deviceId || known.device.deviceGuid !== device.deviceGuid || known.receipt.action !== action) fail(409, 'HOST_ACCOUNT_ISSUE_CONFLICT');
        return { credentials: result(account, known.receipt.legacyCompatible, { requestId: attempt.requestId, state: known.receipt.state }) };
      };
      if (action !== 'migrate') {
        if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 256) fail(400, 'HOST_ACCOUNT_CREDENTIALS_INVALID');
        const legacy = legacyToken && (findPcCredential(store, legacyToken)?.app
          || store.apps.find(app => !isHostAccountScope(app) && app.enabled !== false && app.token === legacyToken));
        if (action === 'register' && legacy?.ownerAccountId) fail(409, 'HOST_ACCOUNT_LEGACY_OWNER_MISMATCH');
        const account = action === 'register' && !known ? createAccount(body) : loginAccount(body);
        if (legacy?.ownerAccountId && legacy.ownerAccountId !== account.id) fail(409, 'HOST_ACCOUNT_LEGACY_OWNER_MISMATCH');
        return complete(account, legacy?.ownerAccountId === account.id);
      }
      const match = findPcCredential(store, legacyToken);
      if (!match || isHostAccountScope(match.app) || match.pcCredential.deviceId !== device.deviceId
        || match.pcCredential.deviceGuid !== device.deviceGuid) fail(403, 'HOST_ACCOUNT_LOGIN_REQUIRED');
      const account = store.accounts.find(item => item.id === match.app.ownerAccountId);
      if (!account) fail(403, 'HOST_ACCOUNT_LOGIN_REQUIRED');
      return complete(account, true);
    },
    recover(action, body, token) {
      if (!requestIdPattern.test(body?.requestId || '') || !/^rbw_[A-Za-z0-9_-]{43}$/.test(token)) fail(404, 'HOST_ACCOUNT_ISSUE_NOT_FOUND');
      const store = readStore();
      const found = findIssue(store, body.requestId, pairingHash(token));
      if (!found || found.device.deviceId !== body.deviceId || found.device.deviceGuid !== body.deviceGuid) fail(404, 'HOST_ACCOUNT_ISSUE_NOT_FOUND');
      const { app, device, receipt } = found;
      const account = store.accounts.find(item => item.id === app.ownerAccountId);
      if (!account) fail(404, 'HOST_ACCOUNT_ISSUE_NOT_FOUND');
      let previousDevice;
      if (action === 'confirm' && receipt.state === 'staged') {
        const previous = app.pcCredentials.find(item => item.deviceGuid === device.deviceGuid);
        if (device.previousHash !== previous?.credentialHash || app.pcCredentials.some(item => item.enabled !== false && item.deviceId === device.deviceId && item.deviceGuid !== device.deviceGuid)) fail(409, 'HOST_ACCOUNT_ISSUE_CONFLICT');
        receipt.state = 'confirmed';
        previousDevice = activate(store, app, validateDevice(device), receipt.credentialHash, receipt);
      }
      return { previousDevice, credentials: result(account, receipt.legacyCompatible, { requestId: receipt.requestId, state: receipt.state }) };
    },
    revoke(token) {
      const store = readStore();
      const match = findPcCredential(store, token);
      if (!match || !isHostAccountScope(match.app)) fail(401, 'HOST_ACCOUNT_AUTH_REQUIRED');
      match.app.pcCredentials = match.app.pcCredentials.filter(item => item !== match.pcCredential);
      if (match.app.hostAccountIssues) match.app.hostAccountIssues = match.app.hostAccountIssues.filter(item => item.deviceGuid !== match.pcCredential.deviceGuid);
      store.workers = store.workers.filter(item => item.appId !== match.app.id || item.id !== match.pcCredential.deviceId || item.guid !== match.pcCredential.deviceGuid);
      writeStore(store);
      return { appId: match.app.id, targetDeviceId: match.pcCredential.deviceGuid, peerId: match.pcCredential.deviceId };
    }
  };
}

export function accountHostTargets(store, sourceApp, isPc) {
  const apps = new Map(store.apps.filter(app => app.enabled !== false && app.ownerAccountId === sourceApp.ownerAccountId).map(app => [app.id, app]));
  const current = new Set(sourceApp.pcCredentials.filter(item => item.enabled !== false && item.appTokenHash === pairingHash(sourceApp.token)).map(item => `${item.deviceId}\0${item.deviceGuid}`));
  const accountGuids = new Set(store.workers.filter(worker => worker.appId === sourceApp.id && current.has(`${worker.id}\0${worker.guid}`)).map(worker => worker.guid));
  return store.workers.flatMap(worker => {
    const app = apps.get(worker.appId);
    if (!app || !isPc(worker)) return [];
    if (app.id === sourceApp.id) return current.has(`${worker.id}\0${worker.guid}`) ? [{ id: worker.id, app, worker }] : [];
    if (isHostAccountScope(app) || (worker.guid && accountGuids.has(worker.guid))) return [];
    const id = `legacy-${createHash('sha256').update(JSON.stringify([app.id, worker.id, worker.guid])).digest('hex').slice(0, 32)}`;
    return [{ id, app, worker }];
  });
}
