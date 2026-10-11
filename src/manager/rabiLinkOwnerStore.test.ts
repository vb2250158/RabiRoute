import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { RabiLinkOwnerStore } from './rabiLinkOwnerStore.js';
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from '../observability/dataMutationAudit.js';

test('owner mutation and backup recovery audit opaque scope without private payload or paths', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-store-audit-'));
  const records: RecordedDataMutationAudit[] = [];
  const uninstall = installDataMutationAuditSink(record => records.push(record));
  t.after(() => { uninstall(); fs.rmSync(directory, { recursive: true, force: true }); });
  const scope = 'private-connection-scope', payload = { secret: 'private-business-payload' };
  const store = new RabiLinkOwnerStore(directory, () => ({}), value => value as typeof payload);
  store.write(scope, payload);
  const file = path.join(directory, createHash('sha256').update(scope).digest('hex') + '.json');
  fs.renameSync(file, file + '.replace-backup');
  assert.deepEqual(store.read(scope), payload);
  assert.deepEqual(records.map(record => [record.action, record.outcome]), [
    ['write', 'started'], ['write', 'committed'], ['recover_backup', 'started'], ['recover_backup', 'committed']
  ]);
  const audit = JSON.stringify(records);
  for (const privateValue of [scope, payload.secret, directory]) assert.equal(audit.includes(privateValue), false);
  const blocker = path.join(directory, 'blocked');
  fs.writeFileSync(blocker, 'file blocks directory creation');
  const blocked = new RabiLinkOwnerStore(blocker, () => ({}), value => value);
  assert.throws(() => blocked.write(scope, payload));
  assert.deepEqual(records.slice(-2).map(record => record.outcome), ['started', 'failed']);
});
