import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TERMINAL_LIMITS } from "./interactive-protocol.mjs";

/** Immutable terminal receipts, not command/output logs. No automatic deletion. */
export class TerminalHistory {
  constructor(directory) { this.directory = directory; }
  filename(id) {
    if (!new RegExp(TERMINAL_LIMITS.idPattern).test(id)) throw new Error("Invalid terminal ID.");
    if (!this.directory) throw new Error("Terminal history storage is not configured.");
    return path.join(this.directory, `${id}.json`);
  }
  async read(id) {
    if (!this.directory) return undefined;
    let file;
    try { file = await fs.open(this.filename(id), "r"); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    try {
      if ((await file.stat()).size > 65536) throw new Error("Terminal history record is too large.");
      const value = JSON.parse(await file.readFile("utf8"));
      if (value.schemaVersion !== 1 || value.terminal?.terminalId !== id || value.terminal.state !== "exited" ||
          typeof value.terminal.shell !== "string" || typeof value.terminal.cwd !== "string" ||
          typeof value.terminal.createdAt !== "string" || !Number.isSafeInteger(value.terminal.nextInputSequence) ||
          value.terminal.nextInputSequence < 1 || !Array.isArray(value.inputs) || value.inputs.length > TERMINAL_LIMITS.inputReceipts ||
          value.inputs.some(row => !Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) ||
            row[0] < 1 || typeof row[1] !== "string" || !/^[a-f0-9]{64}$/.test(row[1])) ||
          (value.startError !== undefined && typeof value.startError !== "string")) throw new Error("Terminal history record is invalid.");
      return value;
    } finally { await file.close(); }
  }
  async save(record) {
    const target = this.filename(record.terminal.terminalId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const data = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(data) > 65536) throw new Error("Terminal history record is too large.");
    const temporary = `${target}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await fs.open(temporary, "wx", 0o600);
      await file.writeFile(data); await file.sync(); await file.close(); file = undefined;
      try { await fs.link(temporary, target); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await this.read(record.terminal.terminalId);
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("Terminal history identity conflict; existing evidence is unchanged.");
      }
      // Windows cannot open directories for fsync. The flushed immutable target
      // remains linked before any hot state is discarded.
      if (process.platform !== "win32") {
        const directory = await fs.open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await file?.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
