import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RabiGlobalConfigStore } from './globalConfig.js';
import { publicRabiLinkRelayConfig } from './rabiApi.js';
const config = () => ({ enabled: false, url: 'http://127.0.0.1:54321/mcp', token: 'test-only-knowledge-secret-1234567890', allowedRoles: ['role-a'], allowedTools: ['plan_list'], allowWrites: false, grants: [{ appId: 'app-a', deviceBindingId: 'device-a', ownerAccountId: 'owner-a' }] });
test('knowledge config defaults off, clones deeply, preserves omitted secret and redacts public data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-config-'));
  try {
    const store = new RabiGlobalConfigStore(root);
    assert.equal(store.read().rabiLinkRelay.knowledgeBridge, undefined);
    store.patch({ rabiLinkRelay: { knowledgeBridge: config() } });
    const snapshot = store.read();
    snapshot.rabiLinkRelay.knowledgeBridge!.allowedRoles!.push('evil');
    snapshot.rabiLinkRelay.knowledgeBridge!.grants![0].ownerAccountId = 'evil';
    assert.deepEqual(store.read().rabiLinkRelay.knowledgeBridge, config());
    store.patch({ rabiLinkRelay: { knowledgeBridge: { enabled: true } as any } });
    assert.equal(store.read().rabiLinkRelay.knowledgeBridge!.token, config().token);
    const exposed = JSON.stringify(publicRabiLinkRelayConfig(store.read().rabiLinkRelay));
    assert.ok(!exposed.includes(config().token));
    assert.ok(exposed.includes('tokenConfigured'));
    const before = fs.readFileSync(store.configPath, 'utf8');
    for (const bad of [{ token: '' }, { token: '********' }, { url: 'https://remote.invalid/mcp' }, { url: 'http://127.0.0.1:99999/mcp' }, { allowedRoles: ['*'] }, { grants: [{}] }, { allowWrites: 'true' }, { unknown: true }]) {
      assert.throws(() => store.patch({ rabiLinkRelay: { knowledgeBridge: { ...config(), ...bad } as any } }), /knowledgeBridge/);
      assert.equal(fs.readFileSync(store.configPath, 'utf8'), before);
    }
    const raw = JSON.parse(before); raw.rabiLinkRelay.knowledgeBridge.url = 'http://remote.invalid/mcp';
    fs.writeFileSync(store.configPath, JSON.stringify(raw));
    const invalid = fs.readFileSync(store.configPath, 'utf8');
    assert.throws(() => new RabiGlobalConfigStore(root), /knowledgeBridge/);
    assert.equal(fs.readFileSync(store.configPath, 'utf8'), invalid);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
