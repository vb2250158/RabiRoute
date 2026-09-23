import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/** Experimental derived-index seam. Not wired into production APIs or cursors. */
export type SqliteKnowledgeRow = { id: string; text: string; kind: string; status: string; archived: boolean; updatedAt: string; tags: string[] };
export type SqliteKnowledgeQuery = { text: string; kind?: string; status?: string; tag?: string; archived?: boolean };
export type SqliteKnowledgePredicate = { sql: string; parameters: Array<string | number> };

export class KnowledgeSqlitePrototype {
  readonly db: DatabaseSync;
  private readDepth = 0;
  private readFault: Error | undefined;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    const columns = this.db.prepare("PRAGMA table_info(documents)").all();
    const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
    if ((columns.length && (version !== 2 || !columns.some(column => column.name === "docid" && column.type === "INTEGER" && column.pk === 1))) || (!columns.length && version !== 0)) {
      this.db.close();
      throw new Error("Experimental index schema requires an explicit rebuild; existing files are not migrated in place");
    }
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS documents(docid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, archived INTEGER NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS document_order ON documents(updatedAt DESC,id ASC);
      CREATE INDEX IF NOT EXISTS document_filter ON documents(kind,archived,status,updatedAt DESC,id ASC);
      CREATE INDEX IF NOT EXISTS document_page_kind_active ON documents(kind,archived,updatedAt DESC,id ASC,status);
      CREATE INDEX IF NOT EXISTS document_page_kind_all ON documents(kind,updatedAt DESC,id ASC,status,archived);
      CREATE TABLE IF NOT EXISTS tags(tag TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(tag,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS tags_by_id ON tags(id);
      CREATE TABLE IF NOT EXISTS short_terms(term TEXT NOT NULL,docid INTEGER NOT NULL REFERENCES documents(docid) ON DELETE CASCADE,PRIMARY KEY(term,docid)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS short_terms_by_docid ON short_terms(docid);
      CREATE VIRTUAL TABLE IF NOT EXISTS fulltext USING fts5(id UNINDEXED,text,tokenize='trigram case_sensitive 1');
      PRAGMA user_version=2;`);
  }
  close(): void { this.db.close(); }
  transaction(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { action(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private writeScope(action: () => void): void {
    const name = `knowledge_write_${randomUUID().replaceAll("-", "")}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { action(); this.db.exec(`RELEASE ${name}`); }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  private clearPostings(id: string, docid: number | bigint): void {
    this.db.prepare("DELETE FROM fulltext WHERE rowid=?").run(docid);
    this.db.prepare("DELETE FROM short_terms WHERE docid=?").run(docid);
    this.db.prepare("DELETE FROM tags WHERE id=?").run(id);
  }
  remove(id: string): void {
    this.writeScope(() => {
      const old = this.db.prepare("SELECT docid FROM documents WHERE id=?").get(id);
      if (!old) return;
      this.clearPostings(id, Number(old.docid));
      this.db.prepare("DELETE FROM documents WHERE id=?").run(id);
    });
  }
  upsert(row: SqliteKnowledgeRow): void {
    this.writeScope(() => {
    const old = this.db.prepare("SELECT docid FROM documents WHERE id=?").get(row.id);
    let docid: number | bigint;
    if (old) {
      docid = Number(old.docid);
      this.clearPostings(row.id, docid);
      this.db.prepare("UPDATE documents SET text=?,kind=?,status=?,archived=?,updatedAt=? WHERE docid=?").run(row.text,row.kind,row.status,Number(row.archived),row.updatedAt,docid);
    } else {
      docid = this.db.prepare("INSERT INTO documents(id,text,kind,status,archived,updatedAt) VALUES (?,?,?,?,?,?)").run(row.id,row.text,row.kind,row.status,Number(row.archived),row.updatedAt).lastInsertRowid;
    }
    this.db.prepare("INSERT INTO fulltext(rowid,id,text) VALUES (?,?,?)").run(docid,row.id,row.text);
    const insertTag = this.db.prepare("INSERT OR IGNORE INTO tags VALUES (?,?)");
    for (const tag of row.tags) insertTag.run(tag,row.id);
    // Code points, not byte trigrams. Unpaired UTF-16 surrogate queries require
    // a JS fallback and are deliberately excluded from this prototype contract.
    const points = Array.from(row.text);
    const terms = new Set<string>();
    for (let i=0;i<points.length;i++) { terms.add(points[i]!); if(i+1<points.length) terms.add(points[i]!+points[i+1]!); }
    const insertTerm = this.db.prepare("INSERT INTO short_terms VALUES (?,?)");
    for (const term of terms) insertTerm.run(term,docid);
    });
  }
  predicate(query: SqliteKnowledgeQuery): SqliteKnowledgePredicate {
    const clauses: string[] = query.text ? ["instr(d.text,?) > 0"] : ["1=1"];
    const parameters: Array<string|number> = query.text ? [query.text] : [];
    const points = Array.from(query.text);
    if (points.length >= 3 && !query.text.includes("\0")) {
      clauses.push("d.rowid IN (SELECT rowid FROM fulltext WHERE fulltext MATCH ?)");
      parameters.push('"'+query.text.replaceAll('"','""')+'"');
    } else if (points.length > 0 && points.length < 3) {
      clauses.push("d.docid IN (SELECT docid FROM short_terms WHERE term=?)"); parameters.push(query.text);
    }
    for(const key of ["kind","status"] as const) if(query[key] !== undefined) { clauses.push(`d.${key}=?`); parameters.push(query[key]!); }
    if(!query.archived) clauses.push("d.archived=0");
    if(query.tag !== undefined) { clauses.push("EXISTS(SELECT 1 FROM tags t WHERE t.id=d.id AND t.tag=?)"); parameters.push(query.tag); }
    return { sql: clauses.join(" AND "), parameters };
  }
  readSnapshot<T>(read: () => T): T {
    // Nested reads already share the outer read-only snapshot; creating another
    // SAVEPOINT under query_only while a caller owns a write transaction fails
    // in SQLite. No inner writes are possible, so reuse that read scope.
    if (this.readFault) throw this.readFault;
    if (this.readDepth) return read();
    const wasReadOnly = Number(this.db.prepare("PRAGMA query_only").get()!.query_only);
    const restoreMode = `PRAGMA query_only=${wasReadOnly ? "ON" : "OFF"}`;
    const savepoint = `knowledge_read_${randomUUID().replaceAll("-", "")}`;
    let opened = false, failed = false;
    let failure: unknown;
    let result!: T;
    const cleanupErrors: unknown[] = [];
    const cleanup = (sql: string): boolean => {
      try { this.db.exec(sql); return true; }
      catch (error) { cleanupErrors.push(error); return false; }
    };
    try {
      this.db.exec(`SAVEPOINT ${savepoint}`);
      opened = true;
      this.db.exec("PRAGMA query_only=ON");
      this.readDepth = 1;
      result = read();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.readDepth = 0;
      const restored = cleanup(restoreMode);
      if (opened) {
        if (failed || !restored) {
          // Release only our uniquely named scope after rollback is confirmed.
          if (cleanup(`ROLLBACK TO ${savepoint}`)) cleanup(`RELEASE ${savepoint}`);
        } else if (!cleanup(`RELEASE ${savepoint}`)) {
          if (cleanup(`ROLLBACK TO ${savepoint}`)) cleanup(`RELEASE ${savepoint}`);
        }
      }
      cleanup(restoreMode);
    }
    if (cleanupErrors.length) {
      this.readFault = new AggregateError(failed ? [failure,...cleanupErrors] : cleanupErrors,
        "Read snapshot cleanup failed; discard this connection", { cause: failed ? failure : cleanupErrors[0] });
      throw this.readFault;
    }
    if (failed) throw failure;
    return result;
  }
  pageSource(query: SqliteKnowledgeQuery): string {
    // Explicit experimental policy: prefer output order for a bounded page.
    // Broad facets retain the optimizer's independent filter/aggregation plan.
    return query.kind === undefined ? "documents d" : `documents d INDEXED BY ${query.archived ? "document_page_kind_all" : "document_page_kind_active"}`;
  }
  search(query: SqliteKnowledgeQuery, limit=20, after?: { updatedAt: string; id: string }) {
    return this.readSnapshot(() => {
    const predicate = this.predicate(query);
    const where = predicate.sql;
    const facets = this.db.prepare(`SELECT status,count(*) AS count FROM documents d WHERE ${where} GROUP BY status ORDER BY status`).all(...predicate.parameters);
    // This experimental contract returns every status facet (no top-K cap), so
    // their sum is the exact total and avoids evaluating the predicate twice.
    const total = facets.reduce((sum, facet) => sum + Number(facet.count), 0);
    const pageWhere = after ? `${where} AND (d.updatedAt < ? OR (d.updatedAt=? AND d.id>?))` : where;
    const parameters = after ? [...predicate.parameters,after.updatedAt,after.updatedAt,after.id,limit] : [...predicate.parameters,limit];
    const items = this.db.prepare(`SELECT id,updatedAt FROM ${this.pageSource(query)} WHERE ${pageWhere} ORDER BY updatedAt DESC,id ASC LIMIT ?`).all(...parameters);
    return { total, facets, items };
    });
  }
}
