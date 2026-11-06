import { createImplementation, hostModules } from "./manager-runtime.mjs";
import { definePlugin } from "@rabiroute/plugin-sdk";

function text(value, fallback, maximumLength) {
  const normalized = String(value ?? fallback).trim();
  return (normalized || fallback).slice(0, maximumLength);
}

function normalizeWearableCompanionConfig(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    enabled: input.enabled !== false,
    roleId: text(input.roleId, "YeYu", 80),
    serial: text(input.serial, "", 160)
  });
}

export const activate = definePlugin({
 async activate(context) {
  const host = context.services.require("host.manager.wearable-companion-runtime@1");
  await host.prepareModules(hostModules);
  const implementation = createImplementation(host);
  const runtime = implementation.createWearableCompanionRuntimeIdentity(host.input);
  const workerHost = context.services.require("host.manager.wearable-companion@2");
  const workers = new implementation.WearableCompanionWorkerService(runtime, workerHost.leases, { startupReady: workerHost.startupReady });
  const config = normalizeWearableCompanionConfig(context.config);
  const state = !config.enabled
    ? "disabled"
    : runtime.unavailableReason || !runtime.pwshPath
      ? "degraded"
      : "managed";
  context.services.provide("manager.wearable-companion@1", Object.freeze({
    instanceId: context.identity.instanceId,
    state,
    applicationGenerationId: runtime.applicationGenerationId,
    managerInstanceId: runtime.managerInstanceId,
    ...(runtime.unavailableReason ? { reason: runtime.unavailableReason } : {})
  }));
  if (state !== "managed") return;

  let handle;
  context.publication.add({
    publish() {},
    rollback() {},
    async afterPublish({ previousRetirement, signal }) {
      await previousRetirement;
      signal.throwIfAborted();
      handle = workers.launch(
        context.identity,
        new URL("./resources/", import.meta.url).href,
        config
      );
      void handle.failure.then(error => {
        if (error && !signal.aborted) context.lifecycle.fail(error);
      });
    },
    retire() { return handle?.dispose(); }
  }, "run published Manager-leased wearable companion worker");
 }
}).activate;
