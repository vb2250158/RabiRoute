/** Transport-independent live voice input fence. Relay retains the opaque client id. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
export const MOBILE_VOICE_CALL_PREFIX = "rabi-call-v1";
export const MOBILE_VOICE_INPUT_TTL_MS = 90_000;

export type MobileVoiceInput = { callId: string; expiresAt: number; workerId: string; routeId: string; eventId: string };

export function mobileVoiceInput(id: unknown): MobileVoiceInput | undefined {
  if (typeof id !== "string" || !id.startsWith(`${MOBILE_VOICE_CALL_PREFIX}.`)) return undefined;
  const parts = id.split(".");
  if (parts.length !== 6 || !/^[a-f0-9-]{36}$/.test(parts[1]!) || !/^\d{13}$/.test(parts[2]!) || !/^[a-f0-9]{64}$/.test(parts[5]!)) throw new Error("Invalid live voice input identity");
  const decode = (value: string) => {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error("Invalid live voice target");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!decoded.trim() || Buffer.from(decoded).toString("base64url") !== value) throw new Error("Invalid live voice target");
    return decoded;
  };
  return { callId: parts[1]!, expiresAt: Number(parts[2]), workerId: decode(parts[3]!), routeId: decode(parts[4]!), eventId: parts[5]! };
}

export function validateMobileVoiceInput(task: Record<string, unknown>, workerId: string, now = Date.now()): MobileVoiceInput | undefined {
  const input = mobileVoiceInput(task.clientMessageId);
  if (!input) return undefined;
  if (input.expiresAt <= now || input.expiresAt > now + MOBILE_VOICE_INPUT_TTL_MS) throw new Error("Live voice input expired or outside its permitted lifetime");
  if (input.workerId !== workerId || input.workerId !== task.targetDeviceId || input.routeId !== task.routeProfileId) throw new Error("Frozen live voice target changed");
  return input;
}

/** Durable claim precedes forwarding. A crash after this point cannot replay an Agent turn. */
export function claimMobileVoiceInput(directory: string, task: Record<string, unknown>, workerId: string, now = Date.now()): void {
  const input = validateMobileVoiceInput(task, workerId, now);
  if (!input) throw new Error("Missing live voice input identity");
  fs.mkdirSync(directory, { recursive: true });
  const key = createHash("sha256").update(String(task.clientMessageId)).digest("hex");
  let fd: number;
  try { fd = fs.openSync(path.join(directory, `${key}.json`), "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Live voice input was already claimed; prior dispatch may be uncertain");
    throw new Error("Live voice input could not be durably claimed");
  }
  const audit = (outcome: "started" | "committed" | "failed") => recordDataMutationAudit({
    group: "mobile-voice-call", event: "live_input_claim", owner: "rabilink-relay-worker",
    action: "claim", target: { type: "live-input", id: key },
    dataSource: { kind: "file", id: key }, outcome
  });
  audit("started");
  try {
    fs.writeFileSync(fd, JSON.stringify({ claimedAt: now, expiresAt: input.expiresAt, state: "claimed" }));
    fs.fsyncSync(fd);
    audit("committed");
  } catch (error) { audit("failed"); throw error; }
  finally { fs.closeSync(fd); }
}
