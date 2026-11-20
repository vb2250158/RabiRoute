import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

// This database lives with the host's local state. The portable JSON records are authoritative.
export class WorkbenchCanvasIndex {
  constructor(stateRoot, sourceRoot) {
    this.file = path.join(stateRoot, "workbench-canvas-index.sqlite");
    this.sourceRoot = sourceRoot;
  }

  async open() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file, { timeout: 2000 });
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (scope TEXT PRIMARY KEY, stamp TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS summaries (
          scope TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT NOT NULL,
          search_name TEXT NOT NULL, summary TEXT NOT NULL, PRIMARY KEY (scope, id)
        );
        CREATE INDEX IF NOT EXISTS summary_order ON summaries(scope, updated_at DESC, id DESC);
      `);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  scope(projectId) { return JSON.stringify([this.sourceRoot, projectId]); }

  stamp(db, scope) {
    return db.prepare("SELECT stamp FROM projects WHERE scope = ?").get(scope)?.stamp;
  }

  putRows(db, scope, rows) {
    const put = db.prepare(`INSERT INTO summaries VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (scope, id) DO UPDATE SET updated_at = excluded.updated_at,
      search_name = excluded.search_name, summary = excluded.summary`);
    for (const row of rows) put.run(scope, row.id, row.updatedAt, row.name.toLocaleLowerCase(), JSON.stringify(row));
  }

  write(db, scope, stamp, change) {
    db.exec("BEGIN IMMEDIATE");
    try {
      change();
      db.prepare("INSERT INTO projects VALUES (?, ?) ON CONFLICT (scope) DO UPDATE SET stamp = excluded.stamp").run(scope, stamp);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  replace(db, scope, stamp, rows) {
    this.write(db, scope, stamp, () => {
      db.prepare("DELETE FROM summaries WHERE scope = ?").run(scope);
      this.putRows(db, scope, rows);
    });
  }

  advance(db, scope, previousStamp, stamp, rows) {
    this.write(db, scope, stamp, () => {
      if (this.stamp(db, scope) !== previousStamp) throw new Error("Canvas index requires a refresh");
      this.putRows(db, scope, rows);
    });
  }

  page(db, scope, search, after, limit) {
    const match = search ? "AND instr(search_name, ?) > 0" : "";
    const seek = after ? "AND (updated_at, id) < (?, ?)" : "";
    const query = db.prepare(`SELECT summary FROM summaries WHERE scope = ? ${match} ${seek}
      ORDER BY updated_at DESC, id DESC LIMIT ?`);
    return query.all(scope, ...(search ? [search] : []), ...(after ? [after.updatedAt, after.id] : []), limit)
      .map(row => JSON.parse(row.summary));
  }
}
