import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`relay exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("relay did not become healthy");
}

test("portable wearable health is allowlisted before a PC worker can claim it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-wearable-health-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, "missing-webgui")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForHealth(baseUrl, child);
    const accountResponse = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "wearable-health-test", password: "strong-test-password" })
    });
    assert.equal(accountResponse.status, 200);
    const cookie = String(accountResponse.headers.get("set-cookie") || "").split(";")[0];
    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Wearable Health Test" })
    });
    assert.equal(appResponse.status, 200);
    const appBody = await appResponse.json();
    const token = appBody.app.token;

    const registerWorker = await fetch(`${baseUrl}/worker/tasks?waitMs=0&deviceId=pc-test`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(registerWorker.status, 200);
    const selectWorker = await fetch(`${baseUrl}/manage/api/apps/${encodeURIComponent(appBody.app.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ targetDeviceId: "pc-test" })
    });
    assert.equal(selectWorker.status, 200);

    const recordedAt = "2026-07-18T12:00:00.000Z";
    const inputResponse = await fetch(`${baseUrl}/api/rabilink/devices/input`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        text: "heart rate 135",
        type: "wearable.health",
        deliveryMode: "observe",
        sourceDeviceId: "watch-test",
        sourceDeviceName: "Test Watch",
        sourceDeviceKind: "watch",
        transport: "phone-companion",
        clientMessageId: "health-test-1",
        capturedAt: Date.parse(recordedAt),
        authKey: "must-not-reach-worker",
        health: {
          policy: {
            heartRateHighBpm: 120,
            heartRateAlertCooldownMinutes: 15,
            token: "must-not-reach-worker-policy"
          },
          samples: [
            {
              id: "heart-test-1",
              metric: "heart_rate",
              recordedAt,
              value: 135,
              unit: "bpm",
              authKey: "must-not-reach-worker-sample",
              metadata: { cookie: "must-not-reach-worker-metadata" }
            },
            {
              id: "sleep-session-test-1",
              metric: "sleep_session",
              recordedAt: "2026-07-18T06:30:00.000Z",
              startAt: "2026-07-17T22:00:00.000Z",
              endAt: "2026-07-18T06:30:00.000Z"
            },
            {
              id: "sleep-stage-test-1",
              metric: "sleep_stage",
              recordedAt: "2026-07-17T23:00:00.000Z",
              startAt: "2026-07-17T22:00:00.000Z",
              endAt: "2026-07-17T23:00:00.000Z",
              sleepStage: "deep",
              metadata: { providerStageCode: "3" }
            },
            {
              id: "sleep-state-test-1",
              metric: "sleep_state",
              recordedAt: "2026-07-18T06:30:00.000Z",
              sleepState: "awake"
            }
          ]
        }
      })
    });
    assert.equal(inputResponse.status, 202);

    const claimResponse = await fetch(`${baseUrl}/worker/tasks?waitMs=0&deviceId=pc-test`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(claimResponse.status, 200);
    const claimBody = await claimResponse.json();
    assert.equal(claimBody.tasks.length, 1);
    const task = claimBody.tasks[0];
    assert.equal(task.type, "wearable.health");
    assert.equal(task.deliveryMode, "observe");
    assert.equal(task.health.samples[0].value, 135);
    assert.equal(task.health.samples.length, 4);
    assert.equal(task.health.samples[1].metric, "sleep_session");
    assert.equal(task.health.samples[2].sleepStage, "deep");
    assert.equal(task.health.samples[2].metadata, undefined);
    assert.equal(task.health.samples[3].sleepState, "awake");
    assert.equal(task.health.policy.heartRateHighBpm, 120);
    const serialized = JSON.stringify(task);
    assert.equal(serialized.includes("must-not-reach-worker"), false);
    assert.equal(serialized.includes("authKey"), false);
    assert.equal(serialized.includes("cookie"), false);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});
