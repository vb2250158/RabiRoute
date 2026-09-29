import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";
import { sanitizeRoleId } from "../../shared/routeIdentity.js";
import { validateXiaomiHomeEvent, type XiaomiHomeEvent } from "../../xiaomiHomeEventDelivery.js";

/** Single Manager-owned, bounded asynchronous append port. Existing history is never rewritten. */
export class XiaomiHomeEventLedger {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly roleDirectory: (roleId: string) => string, private readonly capacity = 64) {}

  async append(roleId: string, event: XiaomiHomeEvent): Promise<void> {
    if (!roleId || sanitizeRoleId(roleId) !== roleId) throw new Error("Invalid Xiaomi event role");
    validateXiaomiHomeEvent(event);
    const line = JSON.stringify({
      time: Math.floor(Date.parse(event.occurredAt) / 1000), isoTime: event.occurredAt,
      id: event.id, kind: event.kind, resourceId: event.resourceId, resourceName: event.resourceName,
      summary: event.summary, artifactId: event.artifactId, areaName: event.areaName, homeId: event.homeId
    }) + "\n";
    if (Buffer.byteLength(line) > 256 * 1024) throw new Error("Xiaomi event is too large");
    if (this.pending >= this.capacity) throw new Error("Xiaomi event ledger queue full");
    this.pending++;
    const flight = this.tail.catch(() => {}).then(async () => {
      const id = createHash("sha256").update(roleId + ":" + event.id).digest("hex");
      const audit = (outcome: "started" | "committed" | "failed") => recordDataMutationAudit({
        group: "xiaomi-home", event: "xiaomi_event_append", owner: "xiaomi-event-ledger", action: "append",
        target: { type: "event", id }, dataSource: { kind: "ledger", id }, outcome
      });
      audit("started");
      try {
        const root = this.roleDirectory(roleId);
        const stat = await fs.lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Xiaomi event role directory");
        const file = path.join(root, "xiaomi-home-events.jsonl");
        try {
          const existing = await fs.lstat(file);
          if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Unsafe Xiaomi event ledger");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await fs.appendFile(file, line, "utf8");
        audit("committed");
      } catch (error) { audit("failed"); throw error; }
    });
    this.tail = flight.catch(() => {});
    try { await flight; } finally { this.pending--; }
  }
}
