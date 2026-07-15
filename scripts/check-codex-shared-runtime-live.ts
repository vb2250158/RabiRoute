import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/codexAppServerClient.js";

const notifications: string[] = [];
const rabi = new CodexAppServerClient({ clientVersion: "live-check" });
const desktopPeer = new CodexAppServerClient({
  clientVersion: "live-check",
  onNotification: (message) => { if (message.method) notifications.push(message.method); }
});

try {
  await Promise.all([rabi.start(), desktopPeer.start()]);
  const created = await rabi.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    serviceName: "rabiroute-live-check"
  }) as { thread?: { id?: string } };
  const threadId = created.thread?.id;
  assert.ok(threadId, "thread/start must return a thread ID");
  const read = await desktopPeer.request("thread/read", { threadId }) as { thread?: { id?: string } };
  assert.equal(read.thread?.id, threadId, "a second client must read the same thread immediately");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(notifications.some((method) => method.startsWith("thread/")), "peer must receive a real-time thread notification");
  console.log(`Shared Runtime live check OK: two clients, same thread ${threadId}, real-time notification observed.`);
} finally {
  rabi.close();
  desktopPeer.close();
}
