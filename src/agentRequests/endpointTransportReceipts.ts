import fs from "node:fs";
import { sameAgentEndpoint } from "./endpoint.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { validateEndpointReceipt } from "./endpointDelivery.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { EndpointDeliveryNotSentError, validateEndpointDeliveryNoFrameProof, type EndpointDeliveryNoFrameProof } from "./deliveryFailure.js";

type NoFrameProof = { kind: "no-prompt-frame"; attemptId: string; observedAt: string };
type TransportEvidence = { deliveryId: string; generation: string; promptHash: string; executionOptionsHash: string;
  target: PreparedEndpointDelivery["target"]; receipt?: EndpointDeliveryReceipt;
  attemptId?: string; attemptSequence?: number; state?: "attempting" | "not_sent";
  dispatchAttemptId?: string;
  noFrameProof?: NoFrameProof; lastNoFrameProof?: NoFrameProof };

/** Transport-only ledger. An attempted operation is never dispatched again after a crash or timeout. */
export class EndpointTransportReceipts {
  constructor(private readonly directory: string) {}
  private mutate<T>(delivery: PreparedEndpointDelivery, action: string, operation: () => T): T {
    const id = createHash("sha256").update(delivery.deliveryId).digest("hex");
    const audit = (outcome: "started" | "committed" | "failed") => recordDataMutationAudit({
      group: "agent.delivery", event: "endpoint_transport_receipt_mutation", owner: "EndpointTransportReceipts", action,
      target: { type: "endpoint_delivery", id }, dataSource: { kind: "ledger", id }, outcome
    });
    audit("started");
    try { const result = operation(); audit("committed"); return result; }
    catch (error) { audit("failed"); throw error; }
  }
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
    if (value.state === "not_sent" && (!value.attemptId || value.noFrameProof?.kind !== "no-prompt-frame"
      || value.noFrameProof.attemptId !== value.attemptId || !Number.isFinite(Date.parse(value.noFrameProof.observedAt)))) {
      throw new Error("Transport no-frame evidence is invalid; original attempt remains unknown.");
    }
    return value;
  }
  async readReceipt(delivery: PreparedEndpointDelivery): Promise<EndpointDeliveryReceipt | undefined> {
    return this.read(delivery)?.receipt;
  }
  async beginAttempt(delivery: PreparedEndpointDelivery): Promise<boolean> {
    const original = this.read(delivery);
    if (original) {
      // Legacy/unknown attempts and receipts never authorize another send. Only
      // a committed proof for the immediately previous attempt can be consumed.
      if (original.receipt || original.state !== "not_sent") return false;
      this.noFrameProof({ ...delivery, dispatchAttemptId: original.dispatchAttemptId }, original);
      // A duplicate management frame is still the original Manager attempt.
      // Only its owner can persist prepared and allocate a new dispatch token.
      if (original.dispatchAttemptId === delivery.dispatchAttemptId) return false;
      return this.mutate(delivery, "consume_no_frame_proof", () => {
        const { noFrameProof, ...retained } = original;
        atomicWriteFileSync(this.file(delivery), JSON.stringify({ ...retained, state: "attempting", attemptId: randomUUID(),
          dispatchAttemptId: delivery.dispatchAttemptId,
          attemptSequence: (original.attemptSequence ?? 1) + 1, lastNoFrameProof: noFrameProof } satisfies TransportEvidence), { mode: 0o600 });
        return true;
      });
    }
    try {
      return this.mutate(delivery, "reserve_attempt", () => {
        fs.mkdirSync(this.directory, { recursive: true });
        const fd = fs.openSync(this.file(delivery), "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ deliveryId: delivery.deliveryId, generation: delivery.generation,
            promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, target: delivery.target,
            dispatchAttemptId: delivery.dispatchAttemptId,
            attemptId: randomUUID(), attemptSequence: 1, state: "attempting" } satisfies TransportEvidence));
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        return true;
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { this.read(delivery); return false; } throw error; }
  }
  async readNotSent(delivery: PreparedEndpointDelivery): Promise<boolean> {
    const evidence = this.read(delivery);
    return evidence?.state === "not_sent" && !evidence.receipt;
  }
  private noFrameProof(delivery: PreparedEndpointDelivery, evidence: TransportEvidence | undefined): EndpointDeliveryNoFrameProof | undefined {
    if (evidence?.state !== "not_sent" || evidence.receipt) return undefined;
    const proof: EndpointDeliveryNoFrameProof = { ...evidence.noFrameProof!, deliveryId: delivery.deliveryId, generation: delivery.generation,
      promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, endpoint: delivery.target,
      dispatchAttemptId: evidence.dispatchAttemptId!,
      attemptId: evidence.attemptId!, attemptSequence: evidence.attemptSequence! };
    validateEndpointDeliveryNoFrameProof(delivery, proof);
    return proof;
  }
  async readNotSentProof(delivery: PreparedEndpointDelivery): Promise<EndpointDeliveryNoFrameProof | undefined> {
    return this.noFrameProof(delivery, this.read(delivery));
  }
  async writeNotSent(delivery: PreparedEndpointDelivery, proof: EndpointDeliveryNotSentError): Promise<void> {
    if (!(proof instanceof EndpointDeliveryNotSentError)) throw new Error("A trusted no-frame error is required.");
    const original = this.read(delivery);
    if (!original?.attemptId || original.receipt || !delivery.dispatchAttemptId || original.dispatchAttemptId !== delivery.dispatchAttemptId) throw new Error("No active transport attempt can accept no-frame evidence.");
    if (original.state === "not_sent") return;
    this.mutate(delivery, "record_no_frame_proof", () => atomicWriteFileSync(this.file(delivery), JSON.stringify({ ...original,
      state: "not_sent", noFrameProof: { kind: "no-prompt-frame", attemptId: original.attemptId!, observedAt: new Date().toISOString() }
    } satisfies TransportEvidence), { mode: 0o600 }));
  }
  async writeReceipt(delivery: PreparedEndpointDelivery, receipt: EndpointDeliveryReceipt): Promise<void> {
    validateEndpointReceipt(delivery, receipt);
    const original = this.read(delivery);
    if (!original) throw new Error("Transport attempt was not reserved.");
    if (original.receipt) return;
    this.mutate(delivery, "write_receipt", () => {
      const file = this.file(delivery);
      const temporary = `${file}.receipt`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ ...original, receipt })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    });
  }
}
