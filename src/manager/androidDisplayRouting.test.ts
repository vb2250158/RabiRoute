import assert from "node:assert/strict";
import test from "node:test";
import { createAndroidDisplayRouting } from "./androidDisplayRouting.js";

const localTarget = { kind: "android-display" as const, bridgeId: "shared-bridge" };
const local = {
  async list() {
    return { targets: [{ name: "Local Android", online: true, capabilities: ["display.open"], target: localTarget }], sourceErrors: [] };
  },
  async execute() { throw new Error("Do not invoke the local display."); }
};

test("peer discovery lists only owned rows and keeps names and identical bridge IDs scoped to their hosts", async () => {
  const paths: string[] = [];
  const routed = createAndroidDisplayRouting(local, {
    localDeviceId: () => "own",
    peers: async () => [
      { deviceId: "own", name: "Self", online: true },
      { deviceId: "remote", name: "Other PC", online: true },
      { deviceId: "old", name: "Old PC", online: true },
      { deviceId: "offline", name: "Offline PC", online: false }
    ],
    async request(device, method, pathname) {
      paths.push(device + " " + method + " " + pathname);
      if (device === "old") return { status: 404, body: {} };
      const directories = await local.list();
      return { status: 200, body: { code: 0, data: { targets: [
        ...directories.targets, { ...directories.targets[0], target: { ...localTarget, ownerDeviceId: "nested-owner" } }
      ], sourceErrors: [] } } };
    }
  });
  assert.deepEqual((await routed.list(undefined, true)).targets.map(row => row.target), [localTarget]);
  assert.deepEqual(paths, []);
  const directory = await routed.list();
  assert.deepEqual(paths, [
    "remote GET /api/device-control/targets?kind=android-display&location=local",
    "old GET /api/device-control/targets?kind=android-display&location=local"
  ]);
  assert.deepEqual(directory.targets.map(row => row.target), [localTarget, { ...localTarget, ownerDeviceId: "remote" }]);
  assert.equal(directory.targets[1]?.name, "Other PC · Local Android");
  assert.deepEqual(directory.sourceErrors, []);
});

test("display open and close preserve one remote owner and reject a response that changes the display identity", async () => {
  const seen: unknown[] = [];
  const remoteTarget = { ...localTarget, ownerDeviceId: "remote" };
  const active = { ...remoteTarget, surfaceId: "opened" };
  let correct = true;
  const routed = createAndroidDisplayRouting(local, {
    localDeviceId: () => "own",
    peers: async () => [],
    async request(peer, method, path, body) {
      seen.push({ peer, method, path, body });
      return { status: 200, body: { code: 0, data: { target: { ...localTarget, surfaceId: correct ? "opened" : "other-display" } } } };
    }
  });
  const result = await routed.execute(remoteTarget, { action: "display.open", requestId: "original" }, "Session A");
  assert.deepEqual(result.body, { code: 0, data: { target: active } });
  assert.deepEqual(seen, [{ peer: "remote", method: "POST", path: "/api/device-control/execute",
    body: { action: "display.open", requestId: "original", target: localTarget } }]);
  correct = false;
  const changed = await routed.execute(active, { action: "display.close" }, undefined);
  assert.equal(changed.status, 502);
  assert.equal((changed.body as Record<string, unknown>).errorCode, "ANDROID_DISPLAY_PEER_OUTCOME_UNCONFIRMED");
  assert.equal((await routed.execute({ ...active, ownerDeviceId: "own" }, { action: "display.close" }, undefined)).status, 409);
  assert.equal(seen.length, 2);
});
