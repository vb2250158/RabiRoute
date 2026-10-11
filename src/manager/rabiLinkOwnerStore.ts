import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { recordDataMutationAudit } from '../observability/dataMutationAudit.js';

/** One PC-owned JSON resource per authenticated connection scope; no credential or account table is stored. */
export class RabiLinkOwnerStore<T> {
  constructor(private readonly directory: string, private readonly empty: () => T, private readonly validate: (value: unknown) => T) {}
  private file(scope: string) { return path.join(this.directory, createHash('sha256').update(scope).digest('hex') + '.json'); }
  private mutate(scope: string, action: string, operation: () => void): void {
    const id = createHash('sha256').update(scope).digest('hex');
    const audit = (outcome: 'started' | 'committed' | 'failed') => recordDataMutationAudit({
      group: 'rabilink', event: 'rabilink_owner_store_mutation', owner: 'RabiLinkOwnerStore', action,
      target: { type: 'connection_scope', id }, dataSource: { kind: 'file', id }, outcome
    });
    audit('started');
    try { operation(); audit('committed'); } catch (error) { audit('failed'); throw error; }
  }
  read(scope: string): T {
    const file = this.file(scope), backup = file + '.replace-backup';
    if (!fs.existsSync(file) && fs.existsSync(backup)) this.mutate(scope, 'recover_backup', () => fs.renameSync(backup, file));
    return fs.existsSync(file) ? this.validate(JSON.parse(fs.readFileSync(file, 'utf8'))) : this.empty();
  }
  write(scope: string, value: T): void {
    this.validate(value);
    this.mutate(scope, 'write', () => {
      fs.mkdirSync(this.directory, { recursive: true });
      const file = this.file(scope), temporary = file + '.' + randomUUID() + '.tmp', backup = file + '.replace-backup';
      const bytes = JSON.stringify(value), descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      if (fs.existsSync(file)) fs.renameSync(file, backup);
      try {
        fs.renameSync(temporary, file);
        if (fs.readFileSync(file, 'utf8') !== bytes) throw new Error('OWNER_STORE_WRITE_READBACK_FAILED');
      } catch (cause) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        if (fs.existsSync(backup)) fs.renameSync(backup, file);
        throw cause;
      }
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
    });
  }
}
