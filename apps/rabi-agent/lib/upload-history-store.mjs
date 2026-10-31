import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_RECEIPT_BYTES = 262144;
const hash = value => createHash("sha256").update(value).digest("hex");
function invalidEvidence(message) { const error = new Error(message); error.code = "UPLOAD_HISTORY_INVALID"; return error; }

/** Same stable config-file namespace as the existing delivery owner, never a token or generation. */
export function uploadHistoryDirectory(dataDirectory, configPath) {
  const owner = hash(path.resolve(configPath)).slice(0, 24);
  return path.join(dataDirectory, "runtime", "computer-upload-history", owner);
}

/** Immutable terminal facts. Reads address one ID; no startup scan or unbounded in-memory index. */
export class UploadHistoryStore {
  constructor({ root, io = fs.promises } = {}) {
    this.root = root; this.io = io; this.writes = new Map(); this.handles = new Map(); this.failedClosedWrites = new Map();
  }
  get openHandleCount() { return this.handles.size; }
  assertConfigured() {
    if (typeof this.root !== "string" || !path.isAbsolute(this.root) || this.root.includes("\0")) {
      throw new Error("Upload history storage requires the original connector's private data root.");
    }
  }
  paths(id) {
    this.assertConfigured();
    const key = hash(id), directory = path.join(this.root, "v1", key.slice(0, 2));
    return { directory, final: path.join(directory, `${key}.json`), pending: path.join(directory, `${key}.pending.json`), retry: path.join(directory, `${key}.retry.json`) };
  }
  encode(upload, confirmedAt) {
    const fact = { schemaVersion: 1, upload: { uploadId: upload.uploadId, path: upload.path, size: upload.size,
      sha256: upload.sha256, offset: upload.offset, state: upload.state }, closed: true, confirmedAt };
    return JSON.stringify({ fact, sha256: hash(JSON.stringify(fact)) }) + "\n";
  }
  decode(text, id) {
    let record;
    try { record = JSON.parse(text); } catch { throw invalidEvidence("Upload history evidence is incomplete; keep the original ID."); }
    const fact = record?.fact, item = fact?.upload;
    if (!fact || fact.schemaVersion !== 1 || fact.closed !== true || !Number.isSafeInteger(fact.confirmedAt)
      || fact.confirmedAt < 0 || !item || item.uploadId !== id || !["committed", "aborted"].includes(item.state)
      || typeof item.path !== "string" || !path.isAbsolute(item.path) || item.path.includes("\0")
      || !Number.isSafeInteger(item.size) || item.size < 0
      || !Number.isSafeInteger(item.offset) || item.offset < 0 || item.offset > item.size
      || item.state === "committed" && item.offset !== item.size || !/^[a-f0-9]{64}$/.test(item.sha256)
      || record.sha256 !== hash(JSON.stringify(fact))) {
      throw invalidEvidence("Upload history evidence is incomplete or conflicts; keep the original ID.");
    }
    return { upload: { uploadId: item.uploadId, path: item.path, size: item.size, sha256: item.sha256,
      offset: item.offset, state: item.state }, confirmedAt: fact.confirmedAt };
  }
  async readFile(filename, id) {
    let stat;
    try { stat = await this.io.stat(filename); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) throw invalidEvidence("Upload history evidence has an invalid size.");
    const bytes = await this.io.readFile(filename);
    if (bytes.length > MAX_RECEIPT_BYTES) throw invalidEvidence("Upload history evidence has an invalid size.");
    return this.decode(bytes.toString("utf8"), id);
  }
  async read(id) {
    const paths = this.paths(id);
    // A complete pending fact reserves its original ID after an interrupted publish.
    // A partial/corrupt fact raises a local error; it is never treated as a fresh upload.
    const final = await this.readFile(paths.final, id);
    if (final) return final;
    let complete = null, incomplete;
    for (const filename of [paths.pending, paths.retry]) {
      let candidate;
      try { candidate = await this.readFile(filename, id); }
      catch (error) { if (error.code !== "UPLOAD_HISTORY_INVALID") throw error; incomplete ??= error; continue; }
      if (!candidate) continue;
      if (complete && this.encode(complete.upload, complete.confirmedAt) !== this.encode(candidate.upload, candidate.confirmedAt)) {
        throw invalidEvidence("Upload history contains conflicting terminal facts; keep the original ID.");
      }
      complete = candidate;
    }
    if (complete) return complete;
    if (incomplete) throw incomplete;
    return null;
  }
  save(upload, confirmedAt) {
    const current = this.writes.get(upload.uploadId);
    if (current) return current;
    const promise = Promise.resolve().then(() => this.write(upload, confirmedAt));
    this.writes.set(upload.uploadId, promise);
    const release = () => { if (this.writes.get(upload.uploadId) === promise) this.writes.delete(upload.uploadId); };
    void promise.then(release, release);
    return promise;
  }
  async write(upload, confirmedAt) {
    const id = upload.uploadId, paths = this.paths(id), text = this.encode(upload, confirmedAt);
    if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) throw new Error("Upload history evidence exceeds its bounded record size.");
    const same = record => record && this.encode(record.upload, record.confirmedAt) === text;
    const existing = await this.readFile(paths.final, id);
    if (existing) {
      if (!same(existing)) throw new Error("Upload identity conflicts with immutable history evidence.");
      for (const filename of [paths.pending, paths.retry]) await this.io.unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
      this.failedClosedWrites.delete(id);
      return;
    }
    const unclosed = this.handles.get(id);
    if (unclosed) throw unclosed.error ?? new Error("Upload history handle close remains unconfirmed.");
    await this.io.mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const failedClosed = this.failedClosedWrites.get(id);
    let workPath = paths.pending, pending = null, syncExisting = false;
    if (failedClosed) {
      if (failedClosed !== hash(text)) throw new Error("Upload identity conflicts with its original failed archive write.");
      workPath = paths.retry;
      try { pending = await this.readFile(workPath, id); }
      catch (error) {
        if (error.code !== "UPLOAD_HISTORY_INVALID") throw error;
        // Only a truly closed, incomplete temporary copy owned by this same fact can be rebuilt.
        // The first pending slot continues to reserve the ID throughout reconstruction.
        await this.io.unlink(workPath).catch(cause => { if (cause.code !== "ENOENT") throw cause; });
      }
      // A full recoverable fact is monotonic: resync it in place, never delete/rewrite it before final publication.
      syncExisting = pending !== null;
    } else pending = await this.readFile(workPath, id);
    if (pending && !same(pending)) throw new Error("Upload identity conflicts with pending history evidence.");
    if (!pending || syncExisting) {
      if (this.handles.size >= 4) throw new Error("Upload history handle capacity reached; unresolved original owners are retained.");
      const owned = { handle: null };
      this.handles.set(id, owned);
      let handle;
      try { handle = await this.io.open(workPath, syncExisting ? "r+" : "wx", 0o600); owned.handle = handle; }
      catch (error) { this.handles.delete(id); throw error; }
      let failure;
      try { if (!syncExisting) await handle.writeFile(text); await handle.sync(); }
      catch (error) { failure = error; }
      try { await handle.close(); this.handles.delete(id); }
      catch (error) { owned.error = error; throw new AggregateError(failure ? [failure, error] : [error], "Upload history handle did not close; original evidence retained."); }
      if (failure) { this.failedClosedWrites.set(id, hash(text)); throw failure; }
    }
    try { await this.io.link(workPath, paths.final); }
    catch (error) {
      if (error.code !== "EEXIST" || !same(await this.readFile(paths.final, id))) throw error;
    }
    if (!same(await this.readFile(paths.final, id))) throw new Error("Upload history publication was not confirmed.");
    this.failedClosedWrites.delete(id);
    // Only this ID's temporary metadata is removed, after its immutable final fact is read back.
    for (const filename of [paths.pending, paths.retry]) await this.io.unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
