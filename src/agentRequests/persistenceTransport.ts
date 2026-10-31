import { setImmediate as yieldImmediate } from "node:timers/promises";
import { serialize } from "node:v8";

type Port = {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: any) => void): unknown;
  off(event: "message", listener: (value: any) => void): unknown;
};
type Operation = { kind: "object" | "array"; id: number }
  | { kind: "scalar"; id: number; value: undefined | null | boolean | number }
  | { kind: "text"; id: number; value: string }
  | { kind: "put"; parent: number; key: number; child: number };
type Frame = { channel: "agent-request-value"; id: string; sequence: number; operations: Operation[]; end: boolean };

/** Structured values, not a second JSON parser/encoder. Every text fragment is bounded. */
function* operations(value: unknown): Generator<Operation> {
  type Task = { kind: "visit"; id: number; value: unknown } | Extract<Operation, { kind: "put" }>;
  let nextId = 1;
  const pending: Task[] = [{ kind: "visit", id: 0, value }];
  while (pending.length) {
    const task = pending.pop()!;
    if (task.kind === "put") { yield task; continue; }
    const { id, value: item } = task;
    if (typeof item === "string") {
      if (!item.length) yield { kind: "text", id, value: "" };
      for (let offset = 0; offset < item.length; offset += 8192) yield { kind: "text", id, value: item.slice(offset, offset + 8192) };
    } else if (item === undefined || item === null || typeof item === "number" || typeof item === "boolean") {
      yield { kind: "scalar", id, value: item };
    } else if (typeof item === "object") {
      yield { kind: Array.isArray(item) ? "array" : "object", id };
      const keys = Object.keys(item);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]!, keyId = nextId++, child = nextId++;
        pending.push({ kind: "put", parent: id, key: keyId, child });
        pending.push({ kind: "visit", id: child, value: Reflect.get(item, key) });
        pending.push({ kind: "visit", id: keyId, value: key });
      }
    } else throw new Error("Agent request persistence messages contain an unsupported value.");
  }
}

/** One acknowledged <=32KiB frame is in flight per sender; receivers yield before acknowledgement. */
export class AgentRequestPersistenceTransport {
  private readonly acknowledgements = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  private readonly incoming = new Map<string, { sequence: number; nodes: Map<number, unknown> }>();
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
    let frame: Operation[] = [], bytes = 0, sequence = 0;
    const send = async (end: boolean) => {
      if (this.stopped) throw this.stopped;
      const current = sequence++, key = `${id}:${current}`;
      const envelope = { channel: "agent-request-value", id, sequence: current, operations: frame, end } satisfies Frame;
      // Advanced child IPC adds a four-byte length prefix to the V8 envelope.
      if (serialize(envelope).byteLength + 4 > 32_768) throw new Error("Persistence frame exceeded its complete wire-byte bound.");
      const acknowledged = new Promise<void>((resolve, reject) => this.acknowledgements.set(key, { resolve, reject }));
      void acknowledged.catch(() => {});
      this.port.postMessage(envelope);
      frame = []; bytes = 0;
      await acknowledged;
    };
    for (const operation of operations(value)) {
      const size = serialize(operation).byteLength + 8;
      if (frame.length && (bytes + size > 32_256 || frame.length >= 128)) await send(false);
      frame.push(operation); bytes += size;
    }
    await send(true);
  }

  private async receive(frame: Frame): Promise<void> {
    if (this.stopped) return;
    if (!Number.isSafeInteger(frame.sequence) || !Array.isArray(frame.operations) || frame.operations.length > 128) throw new Error("Invalid persistence frame.");
    if (serialize(frame).byteLength + 4 > 32_768) throw new Error("Persistence frame exceeded its complete wire-byte bound.");
    let receiver = this.incoming.get(frame.id);
    if (!receiver) { receiver = { sequence: 0, nodes: new Map() }; this.incoming.set(frame.id, receiver); }
    if (frame.sequence !== receiver.sequence++) throw new Error("Persistence frame sequence mismatch.");
    for (const operation of frame.operations) {
      if (operation.kind === "object" || operation.kind === "array") receiver.nodes.set(operation.id, operation.kind === "array" ? [] : {});
      else if (operation.kind === "scalar") receiver.nodes.set(operation.id, operation.value);
      else if (operation.kind === "text") {
        if (operation.value.length > 8192) throw new Error("Persistence text frame exceeded its bound.");
        receiver.nodes.set(operation.id, String(receiver.nodes.get(operation.id) ?? "") + operation.value);
      } else if (operation.kind === "put") {
        const parent = receiver.nodes.get(operation.parent), key = receiver.nodes.get(operation.key);
        if (!parent || typeof parent !== "object" || typeof key !== "string") throw new Error("Invalid persistence value reference.");
        Object.defineProperty(parent, key, { value: receiver.nodes.get(operation.child), writable: true, configurable: true, enumerable: true });
        receiver.nodes.delete(operation.key);
        receiver.nodes.delete(operation.child);
      } else throw new Error("Unknown persistence operation.");
    }
    // The root value stays private until the complete stream is acknowledged.
    const value = frame.end ? receiver.nodes.get(0) : undefined;
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
