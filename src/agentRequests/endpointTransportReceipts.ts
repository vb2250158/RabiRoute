import fs from "node:fs";
import { sameAgentEndpoint } from "./endpoint.js";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { validateEndpointReceipt } from "./endpointDelivery.js";

type TransportEvidence = { deliveryId: string; generation: string; promptHash: string; executionOptionsHash: string; target: PreparedEndpointDelivery["target"]; receipt?: EndpointDeliveryReceipt };

/** Transport-only ledger. An attempted operation is never dispatched again after a crash or timeout. */
export class EndpointTransportReceipts {
  constructor(private readonly directory: string) {}
  private file(delivery: PreparedEndpointDelivery): string {
    return path.join(this.directory, `${createHash("sha256").update(delivery.deliveryId).digest("hex")}.json`);
  }
  private read(delivery: PreparedEndpointDelivery): TransportEvidence | undefined {
    let value: TransportEvidence;
    try { value = JSON.parse(fs.readFileSync(this.file(delivery), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (value.deliveryId !== delivery.deliveryId || value.generation !== delivery.generation
      || value.promptHash !== delivery.promptHash || value.executionOptionsHash !== delivery.executionOptionsHash || !sameAgentEndpoint(value.target, delivery.target)) throw new Error("Transport evidence identity mismatch.");
    if (value.receipt) validateEndpointReceipt(delivery, value.receipt);
    return value;
  }
  async readReceipt(delivery: PreparedEndpointDelivery): Promise<EndpointDeliveryReceipt | undefined> {
    return this.read(delivery)?.receipt;
  }
  async beginAttempt(delivery: PreparedEndpointDelivery): Promise<boolean> {
    if (this.read(delivery)) return false;
    fs.mkdirSync(this.directory, { recursive: true });
    try {
      const fd = fs.openSync(this.file(delivery), "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ deliveryId: delivery.deliveryId, generation: delivery.generation,
          promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, target: delivery.target } satisfies TransportEvidence));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { this.read(delivery); return false; } throw error; }
  }
  async writeReceipt(delivery: PreparedEndpointDelivery, receipt: EndpointDeliveryReceipt): Promise<void> {
    validateEndpointReceipt(delivery, receipt);
    const original = this.read(delivery);
    if (!original) throw new Error("Transport attempt was not reserved.");
    if (original.receipt) return;
    const file = this.file(delivery);
    const temporary = `${file}.receipt`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ ...original, receipt })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
}
