import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { PersonaChatReply } from './shared/personaChatHistory.js';
import { personaHistoryTaskReferences, type PersonaHistoryTaskPage } from './shared/personaChatHistory.js';
import { chatHistoryCategory, type ChatHistoryCategory } from './shared/personaHistoryChannels.js';

export type HistoryIndexRow = { id: string; start: number; end: number; valid: number; textHash: string };
type Checkpoint = { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; invalid: number; identityUnknown: number };
const queues = new Map<string, Promise<unknown>>();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** A disposable projection of the ledger. Never accepts absence until its checkpoint is current. */
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
        CREATE INDEX IF NOT EXISTS task_refs_record ON task_refs(recordId); CREATE INDEX IF NOT EXISTS task_refs_position ON task_refs(taskKey,start);`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  get invalidRecords() { return this.checkpoint.invalid; }
  get size() { return this.checkpoint.size; }
  categories(): ChatHistoryCategory[] {
    return this.db.prepare('SELECT DISTINCT category FROM history WHERE valid=1 AND category IS NOT NULL').all().map(row => row.category as ChatHistoryCategory);
  }
  find(id: string): HistoryIndexRow | undefined { return this.db.prepare('SELECT * FROM history WHERE id=?').get(id) as HistoryIndexRow | undefined; }
  assertIdentityComplete() {
    if (this.checkpoint.identityUnknown) throw new Error('Chat history contains a damaged record with unknown identity; repair that record before adding new replies. Existing replies remain readable.');
  }
  private insert(record: PersonaChatReply, start: number, end: number) {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO history(id,start,end,valid,textHash,category,summary) VALUES (?,?,?,?,?,?,?)').run(record.id, start, end, 1, hash(record.text), chatHistoryCategory(record), JSON.stringify({...record,text:record.text.slice(0,2000),textTruncated:record.text.length>2000,historyCursor:start,historyEndCursor:end}));
    if (inserted.changes) for (const task of personaHistoryTaskReferences(record)) this.db.prepare('INSERT INTO task_refs VALUES (?,?,?,?)').run(task.key,record.id,start,JSON.stringify(task));
  }

  tasks(options: { category?: ChatHistoryCategory; cursor?: string; query?: string; peerOf?: string; limit?: number }): PersonaHistoryTaskPage {
    const args: (string|number)[] = [], conditions = ['h.valid=1'];
    if(options.category){conditions.push('h.category=?');args.push(options.category);}
    if(options.peerOf){conditions.push('r.taskKey<>? AND EXISTS (SELECT 1 FROM task_refs peer WHERE peer.recordId=r.recordId AND peer.taskKey=?)');args.push(options.peerOf,options.peerOf);}
    if(options.query){conditions.push("instr(lower(json_extract(r.descriptor,'$.title')),lower(?))>0");args.push(options.query);}
    let having='';
    if(options.cursor){
      let cursor: {start:number;key:string;scope:string};
      try {cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString());}catch{throw new Error('Invalid task list cursor.');}
      if(!Number.isSafeInteger(cursor.start)||typeof cursor.key!=='string'||cursor.scope!==JSON.stringify([options.category,options.peerOf,options.query]))throw new Error('Invalid task list cursor.');
      having='HAVING MAX(r.start)<? OR (MAX(r.start)=? AND r.taskKey>?)';args.push(cursor.start,cursor.start,cursor.key);
    }
    const limit=options.limit??50;
    const rows=this.db.prepare(`SELECT r.taskKey,r.descriptor,MAX(r.start) AS latest FROM task_refs r JOIN history h ON h.id=r.recordId WHERE ${conditions.join(' AND ')} GROUP BY r.taskKey ${having} ORDER BY latest DESC,r.taskKey LIMIT ?`).all(...args,limit+1);
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
  async prepare() {
    const info = await fs.stat(this.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const saved = this.db.prepare('SELECT value FROM checkpoint').get();
    if (saved) this.checkpoint = JSON.parse(String(saved.value));
    // Match the ledger version contract (device, inode, size, mtime, ctime).
    // Older checkpoints lack ctime/device and must rebuild once before proving absence.
    if (saved && Number.isFinite(this.checkpoint.ctimeMs) && Number.isFinite(this.checkpoint.dev)
      && (info ? this.checkpoint.size === info.size && this.checkpoint.mtimeMs === info.mtimeMs
        && this.checkpoint.ctimeMs === info.ctimeMs && this.checkpoint.dev === info.dev && this.checkpoint.ino === info.ino
        : this.checkpoint.size === 0)) return;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM history; DELETE FROM task_refs;');
      this.checkpoint = { size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0, ctimeMs: info?.ctimeMs ?? 0, dev: info?.dev ?? 0, ino: info?.ino ?? 0, invalid: 0, identityUnknown: 0 };
      if (info) {
        const input = await fs.open(this.file, 'r');
        try {
          let pending = Buffer.alloc(0), offset = 0, position = 0, rows = 0, discardOversized = false;
          while (position < info.size) {
            const chunk = Buffer.alloc(Math.min(65536, info.size - position));
            const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
            if (!bytesRead) throw new Error('Chat history changed while rebuilding its index. Retry the read.');
            position += bytesRead;
            pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
            let newline: number;
            while ((newline = pending.indexOf(10)) >= 0) {
              const line = pending.subarray(0, newline).toString('utf8');
              const end = offset + newline + 1;
              if (line.trim() && !discardOversized) {
                let record: PersonaChatReply | undefined;
                try { record = this.parse(line); }
                catch {
                  this.checkpoint.invalid++;
                  let identity: string | undefined;
                  try {
                    const partial = JSON.parse(line);
                    if (typeof partial?.id === 'string' && partial.id) identity = partial.id;
                  } catch { /* An unreadable identity cannot prove absence for writes. */ }
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
          if (pending.length && !discardOversized) { this.checkpoint.invalid++; this.checkpoint.identityUnknown++; }
          const after = await input.stat();
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.dev !== info.dev || after.ino !== info.ino) throw new Error('Chat history changed while rebuilding its index. Retry the read.');
        } finally { await input.close(); }
      }
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
      this.checkpoint = { ...this.checkpoint, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino };
      this.saveCheckpoint(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
