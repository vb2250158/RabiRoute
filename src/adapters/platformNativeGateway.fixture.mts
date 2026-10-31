import path from "node:path";
import { createFeishuAdapter } from "./feishuAdapter.js";
import { createNapCatAdapter } from "./napcatAdapter.js";
import type { MessageAdapterDispose } from "./messageAdapter.js";

// Controlled child fixture intentionally leaves apiOperations/publishListener absent:
// actual adapter defaults must publish over the supervised Gateway stdout protocol.
const root = process.env.NATIVE_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !process.send) throw new Error("Native Gateway fixture requires its controlled parent.");
const stopFeishu = await createFeishuAdapter({ settings: () => ({ appId: "fixture-app", appSecret: "fixture-app-secret",
  verificationToken: "fixture-verification", encryptKey: "fixture-encrypt", eventSubscriptionEnabled: true,
  webhookPort: 0, webhookPath: "/fixture-feishu" }), dataDir: () => root, memoryDataDir: () => root,
  forward: () => {} }).start() as MessageAdapterDispose;
const stopNapCat = await createNapCatAdapter({ dataDir: () => root, refreshProfile: () => {},
  instances: () => [{ id: "fixture-instance", name: "Native fixture", enabled: true, autoLoginOnRabiStart: false,
    gatewayPort: 0, httpUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:1", accessToken: "" }],
  handleEvent: async event => { process.send?.({ kind: "frame", messageId: event.message_id }); } }).start() as MessageAdapterDispose;
process.on("message", async value => {
  if (value !== "stop") return;
  try { await stopNapCat(); await stopFeishu(); process.disconnect(); }
  catch (error) { console.error(error); process.exitCode = 1; process.disconnect(); }
});
process.send({ kind: "ready" });
