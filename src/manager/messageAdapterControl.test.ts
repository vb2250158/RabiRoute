import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type http from "node:http";
import {
  handleMessageAdapterControlApi,
  MessageAdapterControlService,
  MessageAdapterScanProviderRegistry,
  scanXiaomiHomeEndpoint,
  type MessageAdapterScanResult
} from "./messageAdapterControl.js";

test("Xiaomi Home scan maps the owner health contract without treating pending authorization as connected", () => {
  const pending = scanXiaomiHomeEndpoint({
    status: "authorization_required",
    baseUrl: "http://user:secret@127.0.0.1:8123?token=hidden",
    tokenConfigured: false,
    writeEnabled: false,
    eventMonitor: { enabled: true, connectionState: "authorization_required" },
    cameraCapture: { enabled: false, ready: false, allowedHostCount: 0, inFlight: 0 }
  });
  assert.equal(pending.type, "xiaomiHome");
  assert.equal(pending.label, "米家 / Xiaomi Home");
  assert.equal(pending.endpoints?.[0]?.url, "http://127.0.0.1:8123");
  assert.equal(pending.endpoints?.[0]?.healthy, false);
  assert.equal(pending.requirements?.find(item => item.id === "authorization")?.ok, false);
  assert.match(pending.requirements?.find(item => item.id === "authorization")?.detail ?? "", /待授权/);
  assert.match(pending.requirements?.find(item => item.id === "authorization")?.detail ?? "", /米家消息端卡片/);
  assert.doesNotMatch(pending.requirements?.find(item => item.id === "authorization")?.detail ?? "", /环境变量|RABIROUTE_/);
  assert.equal(JSON.stringify(pending).includes("secret"), false);
  assert.equal(JSON.stringify(pending).includes("hidden"), false);

  const ready = scanXiaomiHomeEndpoint({
    status: "ready",
    baseUrl: "http://homeassistant.local:8123",
    tokenConfigured: true,
    writeEnabled: false,
    eventMonitor: { enabled: true, connectionState: "subscribed" },
    cameraCapture: { enabled: true, ready: true, inFlight: 0 }
  });
  assert.equal(ready.endpoints?.[0]?.healthy, true);
  assert.equal(ready.requirements?.find(item => item.id === "event-monitor")?.ok, true);
  assert.match(ready.warnings?.[0] ?? "", /不是 Gateway 常驻 adapter/);
});

function adapterResult(): MessageAdapterScanResult {
  return {
    type: "webhook",
    label: "Webhook",
    maturity: "experimental",
    installed: true
  };
}

test("message adapter service waits for probes that outlive the response deadline", async () => {
  const providers = new MessageAdapterScanProviderRegistry();
  let release!: () => void;
  const probe = new Promise<MessageAdapterScanResult>(resolve => {
    release = () => resolve(adapterResult());
  });
  providers.register({
    type: "webhook",
    label: "Webhook",
    maturity: "experimental",
    scan: () => probe
  });
  const service = new MessageAdapterControlService(providers, 1);

  const result = await service.scanAdapters();
  assert.equal(result.partial, true);
  assert.equal(service.activeProbeCount(), 1);

  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(service.activeProbeCount(), 0);
  await assert.rejects(() => service.scanAdapters(), /stopping or inactive/);
});

test("message adapter route registers its complete scan operation", async () => {
  const response = new EventEmitter() as http.ServerResponse;
  const request = { method: "GET" } as http.IncomingMessage;
  let release!: () => void;
  const scan = new Promise<Record<string, never>>(resolve => { release = () => resolve({}); });
  let tracked: Promise<unknown> | undefined;

  const handled = handleMessageAdapterControlApi(
    request,
    new URL("http://localhost/api/scan/message-adapters"),
    response,
    {
      service: { scanAdapters: () => scan } as unknown as MessageAdapterControlService,
      scanNapcatHealth: async () => ({
        payload: {} as never,
        diagnostics: {},
        partial: false,
        durationMs: 0,
        deadlineMs: 1
      }),
      gatewayPayload: () => ({}),
      jsonResponse: () => undefined,
      trackOperation: operation => {
        tracked = operation;
        return operation;
      }
    }
  );

  assert.equal(handled, true);
  assert.ok(tracked);
  release();
  await tracked;
});
