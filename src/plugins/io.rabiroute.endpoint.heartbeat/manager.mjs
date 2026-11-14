import { definePlugin } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./manager-runtime.mjs";

// Automation owns schedule configuration. This package supplies its single timer worker.
export const activate = definePlugin({ async activate(context) {
  context.services.provide("endpoint.heartbeat@1", Object.freeze({
    type: "heartbeat", instanceId: context.identity.instanceId, internal: true
  }));
  const source = context.services.optional("manager.persona.automation-source@1");
  const ports = context.services.optional("host.manager.agent-thread-control@2");
  const endpoints = context.services.require("host.message-endpoints@1");
  if (endpoints.manager.readOnly) return;
  if (!source || !ports) {
    console.warn("[role-automation] Independent role schedules are unavailable: Persona source or Agent thread control is not loaded.");
    return;
  }
  await ports.prepareModules(hostModules);
  const runtime = createImplementation(ports).createOwnedRuntime(ports);
  const scheduler = runtime.createScheduler(source);
  let retiring;
  let starting;
  let cancelStarting = () => {};
  const retire = () => {
    cancelStarting();
    return retiring ??= Promise.resolve().then(async () => {
      await scheduler.stop();
      await Promise.resolve(starting).catch(() => {});
    });
  };
  context.effects.add(() => retire, "prepare independent role schedules");
  context.publication.add({
    publish() {}, rollback() {},
    afterPublish({ previousRetirement, signal }) {
      const cancelled = new Promise(resolve => { cancelStarting = resolve; });
      starting = (async () => {
        await Promise.race([previousRetirement, cancelled]);
        if (signal.aborted || retiring) return;
        await scheduler.start();
      })();
      void starting.catch(error => { if (!signal.aborted && !retiring) context.lifecycle.fail(error); });
    },
    retire
  }, "publish independent role schedules");
} }).activate;
