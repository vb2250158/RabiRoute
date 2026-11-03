import { setImmediate as yieldImmediate } from "node:timers/promises";
import { serialize, deserialize } from "node:v8";

type Port = {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: any) => void): unknown;
  off(event: "message", listener: (value: any) => void): unknown;
};
type Frame = { channel: "agent-request-value"; id: string; sequence: number; bytes: Uint8Array; end: boolean };

/** Native structured values, with one acknowledged <=32KiB IPC envelope in flight. */
export class AgentRequestPersistenceTransport {
  private readonly acknowledgements = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  private readonly incoming = new Map<string, { sequence: number; chunks: Uint8Array[] }>();
  private stopped?: Error;
  private sending: Promise<void> = Promise.resolve();
  private readonly listener = (message: any) => {
    if (message?.channel === "agent-request-ack") {
      const key = `${message.id}:${message.sequence}`, waiter = this.acknowledgements.get(key);
      if (waiter) { this.acknowledgements.delete(key); waiter.resolve(); }
      return;
    }
    if (message?.channel !== "agent-request-value") return;
    void this.receive(message as Frame).catch(error => this.onError(error));
  };

  constructor(private readonly port: Port, private readonly onValue: (id: string, value: unknown) => void,
    private readonly onError: (error: unknown) => void) { port.on("message", this.listener); }

  send(id: string, value: unknown): Promise<void> {
    const sent = this.sending.then(() => this.sendValue(id, value));
    this.sending = sent.catch(() => {});
    return sent;
  }

  private async sendValue(id: string, value: unknown): Promise<void> {
    const bytes = serialize(value);
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += 30_720, sequence++) {
      if (this.stopped) throw this.stopped;
      const frame: Frame = { channel: "agent-request-value", id, sequence,
        bytes: bytes.subarray(offset, offset + 30_720), end: offset + 30_720 >= bytes.length };
      if (serialize(frame).byteLength + 4 > 32_768) throw new Error("Persistence frame exceeded its complete wire-byte bound.");
      const key = `${id}:${sequence}`;
      const acknowledged = new Promise<void>((resolve, reject) => this.acknowledgements.set(key, { resolve, reject }));
      void acknowledged.catch(() => {});
      this.port.postMessage(frame);
      await acknowledged;
    }
  }

  private async receive(frame: Frame): Promise<void> {
    if (this.stopped) return;
    if (!Number.isSafeInteger(frame.sequence) || !(frame.bytes instanceof Uint8Array)) throw new Error("Invalid persistence frame.");
    if (serialize(frame).byteLength + 4 > 32_768) throw new Error("Persistence frame exceeded its complete wire-byte bound.");
    let receiver = this.incoming.get(frame.id);
    if (!receiver) { receiver = { sequence: 0, chunks: [] }; this.incoming.set(frame.id, receiver); }
    if (frame.sequence !== receiver.sequence++) throw new Error("Persistence frame sequence mismatch.");
    receiver.chunks.push(frame.bytes);
    const value = frame.end ? deserialize(Buffer.concat(receiver.chunks)) : undefined;
    if (frame.end) this.incoming.delete(frame.id);
    await yieldImmediate();
    if (this.stopped) return;
    this.port.postMessage({ channel: "agent-request-ack", id: frame.id, sequence: frame.sequence });
    if (frame.end) this.onValue(frame.id, value);
  }

  stop(error: Error): void {
    if (this.stopped) return;
    this.stopped = error;
    this.port.off("message", this.listener);
    this.incoming.clear();
    for (const waiter of this.acknowledgements.values()) waiter.reject(error);
    this.acknowledgements.clear();
  }
}
