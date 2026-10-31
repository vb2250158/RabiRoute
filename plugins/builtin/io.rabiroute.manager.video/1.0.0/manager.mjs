import { definePlugin } from "@rabiroute/plugin-sdk";
import fs from "node:fs/promises";
import { createVideoPluginLifecycle } from "./lifecycle.mjs";

export const activate = definePlugin({ async activate(context) {
  const http = context.services.require("host.manager.http@1");
  const host = context.services.require("host.manager.video@1");
  const api = context.services.require("host.manager.operations@1");
  const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
  context.lifecycle.signal.throwIfAborted();
  const runtime = host.createRuntime(context.identity);
  const lifecycle = createVideoPluginLifecycle({ identity: context.identity, signal: context.lifecycle.signal, http, host, api, runtime, catalog });
  context.effects.adopt(lifecycle.publication.retire, "prepared video native owner");
  context.services.provide("manager.video@1", Object.freeze({ instanceId: context.identity.instanceId }));
  const common = { label: { fallback: "媒体工作台" }, routeId: "global.video", hosts: ["web"], order: 51 };
  context.contributions.register({ kind: "page", id: "video-page", value: { ...common, surface: "web.pages", rendererId: "builtin.web-page.video.v1", slot: "route" } });
  context.contributions.register({ kind: "navigation", id: "video", value: { ...common, surface: "web.navigation", icon: "mdi-video-outline", slot: "utility" } });
  context.effects.add(lifecycle.prepare, "prepare video snapshots and operations");
  context.publication.add(lifecycle.publication, "publish video recovery and component ownership");
} }).activate;
