import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { watchGatewayConnection } from "./gatewayConnectionEvents.js";

test("idle drop and recovery publish connection changes after the status file is replaced, without depending on messages", { timeout: 5_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-gateway-connection-test-"));
  const events = new EventEmitter();
  const errors: unknown[] = [];
  const statusFile = path.join(dir, "gateway-status.json");
  const writes = (connected: boolean, lastMessageAt: string) =>
    JSON.stringify({ napcatInstances: { qq: { id: "qq", connected, online: connected, lastMessageAt } } });

  await fs.writeFile(statusFile, writes(true, "initial"));
  const signals: AbortSignal[] = [];
  const published: number[] = [];
  const first = once(events, "change");
  const stop = watchGatewayConnection(dir, {
    async load(file, signal) {
      signals.push(signal);
      const snapshot = JSON.parse(await fs.readFile(file, { encoding: "utf8", signal }));
      events.emit("loaded", snapshot);
      return snapshot;
    },
    async changed() {
      published.push(published.length + 1);
      events.emit("change");
    },
    onError(error) { errors.push(error); }
  });
  const temporary = path.join(dir, "status-next.json");
  t.after(async () => {
    stop();
    await fs.rm(temporary, { force: true });
    await fs.rm(statusFile, { force: true });
    await fs.rmdir(dir);
  });

  await first;
  const counterRead = once(events, "loaded");
  await fs.writeFile(temporary, writes(true, "message-only"));
  await fs.rename(temporary, statusFile);
  await counterRead;
  assert.deepEqual(published, [1]);

  const lost = once(events, "change");
  await fs.writeFile(temporary, writes(false, "message-only"));
  await fs.rename(temporary, statusFile);
  await lost;
  const restored = once(events, "change");
  await fs.writeFile(temporary, writes(true, "message-only"));
  await fs.rename(temporary, statusFile);
  await restored;
  assert.deepEqual(published, [1, 2, 3]);
  assert.deepEqual(errors, []);
  stop();
  assert.ok(signals.length && signals.every(signal => signal.aborted));
});
