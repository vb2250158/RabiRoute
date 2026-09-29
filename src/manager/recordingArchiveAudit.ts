import { createHash } from "node:crypto";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

/** Observe publication without exposing paths, device identities, media or transcripts. */
export async function auditRecordingArchiveMutation<T>(
  owner: string,
  target: string,
  action: () => Promise<T>
): Promise<T> {
  const id = createHash("sha256").update(target).digest("hex");
  const audit = (outcome: "started" | "committed" | "no_change" | "failed") => recordDataMutationAudit({
    group: "recording", event: "recording_archive_mutation", owner, action: "publish",
    target: { type: "recording-archive", id }, dataSource: { kind: "file", id }, outcome
  });
  audit("started");
  try {
    const result = await action();
    audit(result === false ? "no_change" : "committed");
    return result;
  } catch (error) {
    audit("failed");
    throw error;
  }
}
