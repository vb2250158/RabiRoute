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
 activate(context) {
  const runtime = context.services.require("host.manager.wearable-companion-runtime@1");
  const workers = context.services.require("host.manager.wearable-companion@1");
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

  context.effects.add(() => {
    const handle = workers.launch(
      context.identity,
      new URL("./resources/", import.meta.url).href,
      config
    );
    void handle.failure.then(error => {
      if (error) context.lifecycle.fail(error);
    });
    return () => handle.dispose();
  }, "run Manager-leased wearable companion worker");
 }
}).activate;
