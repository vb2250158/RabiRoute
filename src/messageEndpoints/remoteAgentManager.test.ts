import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { RemoteAgentHub } from "./remoteAgentManager.js";

test("RemoteAgentHub rejects task events from devices that do not own the task", async () => {
  const hub = new RemoteAgentHub({
    managerPort: 8790,
    getDefaultGatewayId: () => "main"
  });
  const sentPayloads: string[] = [];
  const deviceRecord = {
    info: { deviceId: "builder-device" },
    socket: {
      readyState: WebSocket.OPEN,
      send: (payload: string) => sentPayloads.push(payload)
    },
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  (hub as unknown as { devices: Map<string, unknown> }).devices.set("builder-device", deviceRecord);

  const task = await hub.createTask({
    deviceId: "builder-device",
    originGatewayId: "main",
    message: "Run the remote build."
  });

  assert.throws(
    () => hub.receiveTaskEvent({
      taskId: task.taskId,
      status: "completed",
      device: { deviceId: "other-device" }
    }),
    /does not own task/
  );

  const updated = hub.receiveTaskEvent({
    taskId: task.taskId,
    status: "completed",
    device: { deviceId: "builder-device" }
  });
  assert.equal(updated.status, "completed");
  assert.equal(sentPayloads.length, 1);
});
