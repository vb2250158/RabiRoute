import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const fields = ['inputTokens','outputTokens','cachedTokens','uncachedTokens','credits','audioSeconds'];

export function usageKey(service) {
  return createHash('sha256').update(JSON.stringify([service.kind,service.id,service.provider,service.endpoint,service.model])).digest('hex');
}

export function createModelUsageStore(file) {
  let db;
  function connect(write) {
    if (!db && (write || existsSync(file))) {
      const opened = new DatabaseSync(file,{timeout:1200});
      try {
        opened.exec('CREATE TABLE IF NOT EXISTS usage_fields (service TEXT NOT NULL, field TEXT NOT NULL, total REAL NOT NULL, measured INTEGER NOT NULL, PRIMARY KEY (service,field))');
        db = opened;
      } catch (error) {
        opened.close();
        throw error;
      }
    }
    return db;
  }

  return {
    record(service, sample = {}) {
      const key = usageKey(service);
      const database = connect(true);
      const add = database.prepare('INSERT INTO usage_fields VALUES (?,?,?,1) ON CONFLICT(service,field) DO UPDATE SET total=total+excluded.total, measured=measured+1');
      database.exec('BEGIN IMMEDIATE');
      try {
        add.run(key,'requests',1);
        for (const field of fields) {
          const value = sample[field];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) add.run(key,field,value);
        }
        if (sample.measuredCacheInput > 0 && Number.isFinite(sample.cachedTokens)
          && sample.cachedTokens >= 0 && sample.cachedTokens <= sample.measuredCacheInput) {
          add.run(key,'measuredCacheInput',sample.measuredCacheInput);
          add.run(key,'measuredCacheHits',sample.cachedTokens);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    read(service) {
      const entries = connect(false)?.prepare('SELECT field,total,measured FROM usage_fields WHERE service=?').all(usageKey(service)) ?? [];
      const stats = Object.fromEntries(entries.map(row=>[row.field,{value:row.total,measured:row.measured}]));
      const cacheBase = stats.measuredCacheInput?.value;
      const cacheHits = stats.measuredCacheHits?.value;
      return { requests: stats.requests?.value ?? 0, metrics: Object.fromEntries(fields.filter(field=>stats[field]).map(field=>[field,stats[field]])),
        ...(cacheBase > 0 && cacheHits !== undefined ? {cacheRate:{value:cacheHits/cacheBase,measured:stats.measuredCacheHits.measured}}:{}) };
    },
    close() { db?.close(); db=undefined; }
  };
}
