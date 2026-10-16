import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";
import { sanitizeRoleId } from "./shared/routeIdentity.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

type TranscriptInput = {
  kind: "tts" | "asr";
  id: unknown;
  text: unknown;
  time: unknown;
  source: string;
};

export function appendDesktopPetTranscript(personaId: string, roleDir: string, input: TranscriptInput): boolean {
  if (!personaId || sanitizeRoleId(personaId) !== personaId) throw new Error("Invalid transcript persona.");
  if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 200
    || typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000
    || typeof input.time !== "number" || !Number.isFinite(input.time) || input.time <= 0) {
    throw new Error("Invalid desktop pet transcript.");
  }
  const record = { schemaVersion: 1, personaId, kind: input.kind, id: input.id,
    source: input.source, text: input.text, time: input.time };
  const key = createHash("sha256").update(JSON.stringify([input.kind, input.source, input.id])).digest("hex");
  const target = path.join(roleDir, "desktop-pet", "transcripts", input.kind, key.slice(0, 2), `${key}.json`);
  return withFileLockSync(`${target}.lock`, () => {
    if (fs.existsSync(target)) {
      const previous = JSON.parse(fs.readFileSync(target, "utf8"));
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Transcript identity already has different content.");
      return false;
    }
    atomicWriteFileSync(target, `${JSON.stringify(record)}\n`);
    recordDataMutationAudit({ group: "speech", event: "desktop_pet_transcript_appended", owner: "desktop-pet",
      action: "append", target: { type: "persona", id: personaId },
      dataSource: { kind: "file", id: `desktop-pet/transcripts/${input.kind}/${key.slice(0, 2)}/${key}.json` },
      outcome: "committed" });
    return true;
  });
}
