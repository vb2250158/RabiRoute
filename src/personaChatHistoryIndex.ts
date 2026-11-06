import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { PersonaChatReply } from './shared/personaChatHistory.js';
import { personaHistoryTaskReferences, type PersonaHistoryTaskPage } from './shared/personaChatHistory.js';
import { chatHistoryCategory, type ChatHistoryCategory } from './shared/personaHistoryChannels.js';

export type HistoryIndexRow = { id: string; start: number; end: number; valid: number; textHash: string };
type Checkpoint = { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; invalid: number; identityUnknown: number; projectionVersion?: number; completeEnd?: number; incompleteTail?: boolean; oversizedTail?: boolean; boundaryHash?: string };
const queues = new Map<string, Promise<unknown>>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Disposable offset and task projections; the JSONL ledger remains authoritative. */
export async function withPersonaHistoryIndex<T>(file: string, parse: (line: string) => PersonaChatReply,
  action: (index: PersonaHistoryIndex) => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let index: PersonaHistoryIndex;
    try { index = new PersonaHistoryIndex(file, parse); }
    catch (error) {
      // Only the disposable projection is rebuilt. Permission/I/O failures retain their cause.
      if (![11, 26].includes(Number((error as {errcode?: number}).errcode))) throw error;
      await fs.unlink(file + '.index.sqlite');
      index = new PersonaHistoryIndex(file, parse);
    }
    try { await index.prepare(); return await action(index); }
    finally { index.close(); }
  });
  queues.set(file, task);
  try { return await task; } finally { if (queues.get(file) === task) queues.delete(file); }
}

export class PersonaHistoryIndex {
  private readonly db: DatabaseSync;
  private readonly insertStatements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private checkpoint: Checkpoint = { size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0, invalid: 0, identityUnknown: 0 };
  constructor(private readonly file: string, private readonly parse: (line: string) => PersonaChatReply) {
    this.db = new DatabaseSync(file + '.index.sqlite');
    try {
      this.db.exec(`PRAGMA cache_size=-2048; CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, start INTEGER, end INTEGER, valid INTEGER, textHash TEXT);
        CREATE INDEX IF NOT EXISTS history_position ON history(start); CREATE TABLE IF NOT EXISTS checkpoint (value TEXT);`);
      if (!this.db.prepare('PRAGMA table_info(history)').all().some(row => row.name === 'category')) {
        this.db.exec('ALTER TABLE history ADD COLUMN category TEXT; DELETE FROM checkpoint;');
      }
      if (!this.db.prepare('PRAGMA table_info(history)').all().some(row => row.name === 'summary')) {
        this.db.exec('ALTER TABLE history ADD COLUMN summary TEXT; DELETE FROM checkpoint;');
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_refs (taskKey TEXT, recordId TEXT, start INTEGER, descriptor TEXT, PRIMARY KEY(taskKey,recordId));
        CREATE INDEX IF NOT EXISTS task_refs_record ON task_refs(recordId); CREATE INDEX IF NOT EXISTS task_refs_position ON task_refs(taskKey,start);
        CREATE TABLE IF NOT EXISTS task_summary (category TEXT, taskKey TEXT, latest INTEGER, descriptor TEXT, PRIMARY KEY(category,taskKey));
        CREATE INDEX IF NOT EXISTS task_summary_page ON task_summary(category,latest DESC,taskKey);
        CREATE TABLE IF NOT EXISTS task_peer_summary (category TEXT, peerKey TEXT, taskKey TEXT, latest INTEGER, descriptor TEXT, PRIMARY KEY(category,peerKey,taskKey));
        CREATE INDEX IF NOT EXISTS task_peer_summary_page ON task_peer_summary(category,peerKey,latest DESC,taskKey);`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  get invalidRecords() { return this.checkpoint.invalid; }
  get size() { return this.checkpoint.size; }
  get appendSeparator(): '' | '\n' { return this.checkpoint.incompleteTail || this.checkpoint.oversizedTail ? '\n' : ''; }
  categories(): ChatHistoryCategory[] {
    return this.db.prepare('SELECT DISTINCT category FROM history WHERE valid=1 AND category IS NOT NULL').all().map(row => row.category as ChatHistoryCategory);
  }
  find(id: string): HistoryIndexRow | undefined { return this.db.prepare('SELECT * FROM history WHERE id=?').get(id) as HistoryIndexRow | undefined; }
  get unknownIdentityRecords() { return this.checkpoint.identityUnknown; }
  private insertStatement(sql: string) {
    let statement = this.insertStatements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.insertStatements.set(sql, statement); }
    return statement;
  }
  private insert(record: PersonaChatReply, start: number, end: number) {
    const inserted = this.insertStatement('INSERT OR IGNORE INTO history(id,start,end,valid,textHash,category,summary) VALUES (?,?,?,?,?,?,?)').run(record.id, start, end, 1, hash(record.text), chatHistoryCategory(record), JSON.stringify({...record,text:record.text.slice(0,2000),textTruncated:record.text.length>2000,historyCursor:start,historyEndCursor:end}));
    if (inserted.changes) {
      const tasks = personaHistoryTaskReferences(record);
      for (const task of tasks) {
        const descriptor = JSON.stringify(task);
        this.insertStatement('INSERT INTO task_refs VALUES (?,?,?,?)').run(task.key, record.id, start, descriptor);
        for (const category of ['', chatHistoryCategory(record)]) {
          this.insertStatement('INSERT INTO task_summary VALUES (?,?,?,?) ON CONFLICT(category,taskKey) DO UPDATE SET latest=excluded.latest,descriptor=excluded.descriptor WHERE excluded.latest>task_summary.latest')
            .run(category, task.key, start, descriptor);
          for (const peer of tasks) if (peer.key !== task.key) {
            this.insertStatement('INSERT INTO task_peer_summary VALUES (?,?,?,?,?) ON CONFLICT(category,peerKey,taskKey) DO UPDATE SET latest=excluded.latest,descriptor=excluded.descriptor WHERE excluded.latest>task_peer_summary.latest')
              .run(category, peer.key, task.key, start, descriptor);
          }
        }
      }
    }
  }

  tasks(options: { category?: ChatHistoryCategory; cursor?: string; query?: string; peerOf?: string; limit?: number }): PersonaHistoryTaskPage {
    const args: (string|number)[] = [options.category ?? ''], conditions = ['category=?'];
    const table = options.peerOf ? 'task_peer_summary' : 'task_summary';
    if (options.peerOf) { conditions.push('peerKey=?'); args.push(options.peerOf); }
    if (options.query) { conditions.push("instr(lower(json_extract(descriptor,'$.title')),lower(?))>0"); args.push(options.query); }
    if (options.cursor) {
      let cursor: {start:number;key:string;scope:string};
      try { cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString()); } catch { throw new Error('Invalid task list cursor.'); }
      if (!Number.isSafeInteger(cursor.start) || typeof cursor.key!=='string' || cursor.scope!==JSON.stringify([options.category,options.peerOf,options.query])) throw new Error('Invalid task list cursor.');
      conditions.push('(latest<? OR (latest=? AND taskKey>?))'); args.push(cursor.start,cursor.start,cursor.key);
    }
    const limit=options.limit??50;
    // A title search historically matches older recorded names as well as the
    // latest one. Keep that exact scope instead of searching only new summaries.
    let rows;
    if (options.query) {
      const searchArgs: (string | number)[] = [], searchConditions = ['h.valid=1'];
      if (options.category) { searchConditions.push('h.category=?'); searchArgs.push(options.category); }
      if (options.peerOf) { searchConditions.push('r.taskKey<>? AND EXISTS (SELECT 1 FROM task_refs peer WHERE peer.recordId=r.recordId AND peer.taskKey=?)'); searchArgs.push(options.peerOf, options.peerOf); }
      searchConditions.push("instr(lower(json_extract(r.descriptor,'$.title')),lower(?))>0"); searchArgs.push(options.query);
      let having = '';
      if (options.cursor) {
        const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
        having = 'HAVING MAX(r.start)<? OR (MAX(r.start)=? AND r.taskKey>?)'; searchArgs.push(cursor.start, cursor.start, cursor.key);
      }
      rows = this.db.prepare('SELECT r.taskKey,r.descriptor,MAX(r.start) AS latest FROM task_refs r JOIN history h ON h.id=r.recordId WHERE '+searchConditions.join(' AND ')+' GROUP BY r.taskKey '+having+' ORDER BY latest DESC,r.taskKey LIMIT ?').all(...searchArgs, limit+1);
    } else rows=this.db.prepare('SELECT taskKey,descriptor,latest FROM '+table+' WHERE '+conditions.join(' AND ')+' ORDER BY latest DESC,taskKey LIMIT ?').all(...args,limit+1);
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page.map(row=>JSON.parse(String(row.descriptor))),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({start:Number(last.latest),key:String(last.taskKey),scope:JSON.stringify([options.category,options.peerOf,options.query])})).toString('base64url'):null,invalidRecords:this.invalidRecords};
  }
  taskHistory(taskKey:string, category:ChatHistoryCategory|undefined,cursor:number|undefined,limit:number,newer:boolean) {
    const args:(string|number)[]=[taskKey],conditions=['r.taskKey=?','h.valid=1'];
    if(category){conditions.push('h.category=?');args.push(category);}
    if(cursor!==undefined){conditions.push(newer?'h.start>=?':'h.start<?');args.push(cursor);}
    return this.db.prepare(`SELECT h.* FROM history h JOIN task_refs r ON r.recordId=h.id WHERE ${conditions.join(' AND ')} ORDER BY h.start ${newer?'ASC':'DESC'} LIMIT ?`).all(...args,limit+1) as (HistoryIndexRow&{summary:string})[];
  }

  private saveCheckpoint() {
    this.db.prepare('DELETE FROM checkpoint').run();
    this.db.prepare('INSERT INTO checkpoint VALUES (?)').run(JSON.stringify(this.checkpoint));
  }
  private async boundaryHash(size: number): Promise<string> {
    if (!size) return hash('');
    const input = await fs.open(this.file, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(4096, size));
      const { bytesRead } = await input.read(bytes, 0, bytes.length, size - bytes.length);
      if (bytesRead !== bytes.length) throw new Error('Chat history changed while checking its append boundary.');
      return createHash('sha256').update(bytes).digest('hex');
    } finally { await input.close(); }
  }
  async prepare() {
    const info = await fs.stat(this.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const saved = this.db.prepare('SELECT value FROM checkpoint').get();
    if (saved) this.checkpoint = JSON.parse(String(saved.value));
    const previous = this.checkpoint;
    const currentProjection = previous.projectionVersion === 2 && Number.isSafeInteger(previous.completeEnd)
      && Number.isFinite(previous.ctimeMs) && Number.isFinite(previous.dev);
    if (saved && currentProjection && (info ? previous.size === info.size && previous.mtimeMs === info.mtimeMs
      && previous.ctimeMs === info.ctimeMs && previous.dev === info.dev && previous.ino === info.ino
      : previous.size === 0)) return;
    // The source owner appends JSONL. An external append consumes only its new
    // suffix; replacement, truncation or a changed old tail rebuilds this cache.
    const incremental = Boolean(saved && currentProjection && info && info.size > previous.size
      && info.dev === previous.dev && info.ino === previous.ino && previous.boundaryHash
      && previous.boundaryHash === await this.boundaryHash(previous.size));
    this.db.exec('BEGIN');
    try {
      if (!incremental) this.db.exec('DELETE FROM history; DELETE FROM task_refs; DELETE FROM task_summary; DELETE FROM task_peer_summary;');
      this.checkpoint = {
        size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0, ctimeMs: info?.ctimeMs ?? 0, dev: info?.dev ?? 0, ino: info?.ino ?? 0,
        invalid: incremental ? previous.invalid - Number(Boolean(previous.incompleteTail)) : 0,
        identityUnknown: incremental ? previous.identityUnknown - Number(Boolean(previous.incompleteTail)) : 0, projectionVersion: 2, completeEnd: 0
      };
      if (info) {
        const input = await fs.open(this.file, 'r');
        try {
          const start = incremental ? previous.completeEnd! : 0;
          let pending = Buffer.alloc(0), offset = start, position = start, rows = 0, discardOversized = incremental && Boolean(previous.oversizedTail);
          while (position < info.size) {
            const chunk = Buffer.alloc(Math.min(65536, info.size - position));
            const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
            if (!bytesRead) throw new Error('Chat history changed while rebuilding its index. Retry the read.');
            position += bytesRead;
            pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
            let newline: number;
            while ((newline = pending.indexOf(10)) >= 0) {
              const line = pending.subarray(0, newline).toString('utf8'), end = offset + newline + 1;
              if (line.trim() && !discardOversized) {
                let record: PersonaChatReply | undefined;
                try { record = this.parse(line); }
                catch {
                  this.checkpoint.invalid++;
                  let identity: string | undefined;
                  try {
                    const partial = JSON.parse(line);
                    if (typeof partial?.id === 'string' && partial.id) identity = partial.id;
                  } catch { /* Keep unreadable identities as a local index diagnostic. */ }
                  if (identity) this.db.prepare('INSERT OR IGNORE INTO history(id,start,end,valid,textHash) VALUES (?,?,?,?,?)').run(identity, offset, end, 0, '');
                  else this.checkpoint.identityUnknown++;
                }
                if (record) this.insert(record, offset, end);
              }
              pending = pending.subarray(newline + 1); offset = end; discardOversized = false;
              if (++rows % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
            }
            if (pending.length > 1024 * 1024) {
              if (!discardOversized) { this.checkpoint.invalid++; this.checkpoint.identityUnknown++; }
              discardOversized = true; offset += pending.length; pending = Buffer.alloc(0);
            }
          }
          this.checkpoint.incompleteTail = Boolean(pending.length && !discardOversized);
          if (this.checkpoint.incompleteTail) { this.checkpoint.invalid++; this.checkpoint.identityUnknown++; }
          this.checkpoint.oversizedTail = discardOversized;
          this.checkpoint.completeEnd = discardOversized ? info.size : offset;
          this.checkpoint.boundaryHash = await this.boundaryHash(info.size);
          const after = await input.stat();
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.dev !== info.dev || after.ino !== info.ino) throw new Error('Chat history changed while rebuilding its index. Retry the read.');
        } finally { await input.close(); }
      } else { this.checkpoint.boundaryHash = hash(''); }
      this.saveCheckpoint(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async read(row: HistoryIndexRow): Promise<PersonaChatReply> {
    const input = await fs.open(this.file, 'r');
    try {
      const buffer = Buffer.alloc(row.end - row.start);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, row.start);
      if (bytesRead !== buffer.length) throw new Error('Chat history changed; refresh this reply.');
      const record = this.parse(buffer.toString('utf8'));
      if (record.id !== row.id || hash(record.text) !== row.textHash) throw new Error('Chat history changed; refresh this reply.');
      return record;
    } finally { await input.close(); }
  }
  async appended(records: readonly PersonaChatReply[], start: number) {
    const info = await fs.stat(this.file);
    this.db.exec('BEGIN');
    try {
      let offset = start;
      for (const record of records) {
        const end = offset + Buffer.byteLength(JSON.stringify(record) + '\n');
        this.insert(record, offset, end); offset = end;
      }
      if (offset !== info.size) throw new Error('Chat history changed while recording its index.');
      this.checkpoint = { ...this.checkpoint, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino,
        projectionVersion: 2, completeEnd: info.size, incompleteTail: false, oversizedTail: false, boundaryHash: await this.boundaryHash(info.size) };
      this.saveCheckpoint(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
