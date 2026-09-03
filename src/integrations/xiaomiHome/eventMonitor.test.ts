import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { XiaomiHomeEventMonitor, xiaomiHomeEventFromHomeAssistantStateChange, xiaomiMiotMotionClipFromStateChange } from "./eventMonitor.js";

class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit("close"); }
}

test("event monitor exposes authorization and subscription state without exposing credentials", () => {
  const missing = new XiaomiHomeEventMonitor({}, {
    deliverEvent: async () => undefined
  });
  assert.equal(missing.start(), false);
  assert.deepEqual(missing.status(), {
    enabled: true,
    authorizationConfigured: false,
    running: false,
    connectionState: "authorization_required",
    deliveryMode: "significant",
    cameraMotionEntityCount: 0,
    agentRoleConfigured: true
  });

  const socket = new FakeSocket();
  const connected = new XiaomiHomeEventMonitor({}, {
    credentialToken: "private-value",
    createSocket: () => socket,
    deliverEvent: async () => undefined
  });
  assert.equal(connected.start(), true);
  socket.emit("message", JSON.stringify({ type: "auth_required" }));
  socket.emit("message", JSON.stringify({ type: "auth_ok" }));
  socket.emit("message", JSON.stringify({ type: "result", id: 1, success: true }));
  assert.equal(connected.status().connectionState, "subscribed");
  assert.equal(JSON.stringify(connected.status()).includes("private-value"), false);
  connected.stop();
});

test("maps an explicitly configured camera motion entity to the single Xiaomi Home event contract", () => {
  const event = xiaomiHomeEventFromHomeAssistantStateChange({
    event_type: "state_changed",
    time_fired: "2026-08-29T09:00:00.000Z",
    data: {
      entity_id: "binary_sensor.front_door_person",
      new_state: {
        entity_id: "binary_sensor.front_door_person",
        state: "on",
        attributes: { friendly_name: "门口有人", device_class: "motion" }
      }
    }
  }, { cameraMotionEntityIds: ["binary_sensor.front_door_person"] });
  assert.equal(event?.kind, "camera_motion_detected");
  assert.equal(event?.resourceId, "home:ha:binary_sensor.front_door_person");
});

test("significant mode drops ordinary state churn but retains offline state", () => {
  const ordinary = xiaomiHomeEventFromHomeAssistantStateChange({
    event_type: "state_changed",
    data: { entity_id: "sensor.temperature", new_state: { entity_id: "sensor.temperature", state: "24" } }
  });
  assert.equal(ordinary, undefined);
  const offline = xiaomiHomeEventFromHomeAssistantStateChange({
    event_type: "state_changed",
    time_fired: "2026-08-29T09:00:00.000Z",
    data: { entity_id: "light.desk", new_state: { entity_id: "light.desk", state: "unavailable" } }
  });
  assert.equal(offline?.kind, "device_offline");
});

test("recognizes a new Xiaomi Miot motion video without exposing it in the routed event", () => {
  const change = {
    event_type: "state_changed",
    time_fired: "2026-08-29T09:00:00.000Z",
    data: {
      entity_id: "camera.front_door",
      old_state: {
        entity_id: "camera.front_door",
        state: "idle",
        attributes: { motion_video_time: 100, motion_video_latest: "https://media.example/old.m3u8" }
      },
      new_state: {
        entity_id: "camera.front_door",
        state: "idle",
        attributes: {
          friendly_name: "门口摄像头",
          motion_video_time: 1787994000,
          motion_video_type: "PeopleMotion",
          motion_video_latest: "https://media.example/new.m3u8"
        }
      }
    }
  };
  const candidate = xiaomiMiotMotionClipFromStateChange(change);
  assert.equal(candidate?.eventType, "PeopleMotion");
  assert.equal(candidate?.playlistUrl, "https://media.example/new.m3u8");
  const routed = xiaomiHomeEventFromHomeAssistantStateChange(change);
  assert.equal(routed?.kind, "camera_motion_detected");
  assert.equal("playlistUrl" in (routed ?? {}), false);
});
