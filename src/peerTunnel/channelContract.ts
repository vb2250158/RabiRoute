import type { EventEmitter } from "node:events";

export interface TunnelChannel extends EventEmitter { send(bytes: Buffer): Promise<void>; close(): void | Promise<void>; }
