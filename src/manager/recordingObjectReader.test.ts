import assert from "node:assert/strict";
import test from "node:test";
import { readRecordingAudio, readRecordingObject } from "./recordingObjectReader.js";

const missing = async (): Promise<Buffer> => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };

test("legacy cache hits do not read the archive", async () => {
  let archiveReads = 0;
  const bytes = await readRecordingObject("phone-a", "object-a", async () => Buffer.from("legacy"), async () => { archiveReads++; return Buffer.from("archive"); });
  assert.equal(bytes?.toString(), "legacy");
  assert.equal(archiveReads, 0);
});

test("archive fallback retains the exact object owner and identifier", async () => {
  const seen: string[][] = [];
  const bytes = await readRecordingObject("phone-a", "object-a", missing, async (owner, id) => { seen.push([owner, id]); return Buffer.from("archived"); });
  assert.equal(bytes?.toString(), "archived");
  assert.deepEqual(seen, [["phone-a", "object-a"]]);
  assert.equal(await readRecordingObject("phone-b", "object-a", missing, missing), undefined);
});

test("playback keeps available chunks in order and rejects entirely unavailable media", async () => {
  const read = async (_owner: string, id: string) => id === "missing" ? undefined : Buffer.from(id);
  assert.equal((await readRecordingAudio("phone-a", ["one", "missing", "two"], read)).toString(), "onetwo");
  await assert.rejects(readRecordingAudio("phone-a", ["missing"], read), /Recording audio unavailable/);
  await assert.rejects(readRecordingAudio("phone-a", [], read), /Recording audio unavailable/);
});

test("revocation after a failed cache read prevents archive fallback", async () => {
  let allowed = true, archiveReads = 0;
  const authorize = () => { if (!allowed) throw new Error("revoked"); };
  await assert.rejects(readRecordingObject("phone-a", "object-a", async () => { allowed = false; throw new Error("missing"); }, async () => { archiveReads++; return Buffer.from("private"); }, authorize), /revoked/);
  assert.equal(archiveReads, 0);
});

test("revocation after archive completion prevents accepting its bytes", async () => {
  let allowed = true;
  const authorize = () => { if (!allowed) throw new Error("revoked"); };
  await assert.rejects(readRecordingObject("phone-a", "object-a", missing, async () => { allowed = false; return Buffer.from("private"); }, authorize), /revoked/);
});

test("playback checks authority after missing chunks before returning earlier bytes", async () => {
  let allowed = true;
  const authorize = () => { if (!allowed) throw new Error("revoked"); };
  await assert.rejects(readRecordingAudio("phone-a", ["one", "missing"], async (_owner, id) => { if (id === "missing") { allowed = false; return undefined; } return Buffer.from(id); }, authorize), /revoked/);
});
