import { definePlugin } from "@rabiroute/plugin-sdk";
import fs from "node:fs/promises";
import { checkedFs, checkedReadBody } from "./requestAccess.mjs";
import { streamMedia } from "./media.mjs";
import { VideoService, VideoError } from "./service.mjs";
import { VideoModels } from "./models.mjs";
import path from "node:path";
import { VideoAssets, assetTypes } from "./assets.mjs";
import { VideoProjects, handleProjects } from "./projects.mjs";

export function dispatchVideoRequest(runtime, http, request, response, handle) {
  let access;
  void Promise.resolve().then(() => {
    access = runtime.requestAccess(request);
    return handle(access);
  }).catch(error => {
    try { access?.assert(); } catch (denied) { error = denied; }
    if (error?.code === "VIDEO_REQUEST_FORBIDDEN" || access?.denied) {
      if (response.headersSent) { response.destroy(); return; }
      for (const name of response.getHeaderNames()) response.removeHeader(name);
      response.setHeader("cache-control", "no-store");
      http.jsonResponse(response, 403, {
        error: "forbidden", message: "视频请求权限已失效。",
        ...(request.method !== "GET" ? { mutation: access?.mutationStarted ? "unknown" : "not_started" } : {})
      });
      return;
    }
    if (response.headersSent) { response.destroy(); return; }
    http.jsonResponse(response, error instanceof VideoError ? error.status : 503, {
      message: error instanceof VideoError ? error.message : "视频服务不可用，请检查运行环境与视频服务日志。"
    });
  });
}

export const activate = definePlugin({ async activate(context) {
  const http = context.services.require("host.manager.http@1");
  const runtime = context.services.require("host.manager.video@1").createRuntime(context.identity);
  const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
  context.services.provide("manager.video@1", Object.freeze({ instanceId: context.identity.instanceId }));
  const common = { label: { fallback: "媒体工作台" }, routeId: "global.video", hosts: ["web"], order: 51 };
  context.contributions.register({ kind: "page", id: "video-page", value: { ...common, surface: "web.pages", rendererId: "builtin.web-page.video.v1", slot: "route" } });
  context.contributions.register({ kind: "navigation", id: "video", value: { ...common, surface: "web.navigation", icon: "mdi-video-outline", slot: "utility" } });
  context.effects.add(async () => {
    const service = new VideoService(runtime, catalog, (name, data) => http.publishManagerEvent("plugin_event", { instanceId: context.identity.instanceId, name, data }));
    await service.initialize();
    const assets = new VideoAssets(runtime); service.assets = assets;
    const projects = new VideoProjects(runtime);
    if(!runtime.readOnly) { await fs.mkdir(runtime.componentRoot,{recursive:true}); await fs.copyFile(new URL("./inspect-media.py",import.meta.url),path.join(runtime.componentRoot,"inspect-media.py")); }
    const models = new VideoModels(runtime, catalog, () => http.publishManagerEvent("plugin_event", { instanceId: context.identity.instanceId, name: "video.models", data: {} }));
    await models.initialize();
    const tracker = new http.ManagerPluginRequestTracker();
    async function handle(request, url, response, access) {
      const fs = checkedFs(access); access?.assert();
      const respond = (response, value, status = 200) => { access?.assert(); return http.jsonResponse(response, status, value); };
      const route = url.pathname.slice("/api/video".length);
      if (await handleProjects(projects,request,url,response,http,access)) return;
      if(request.method==="POST" && route==="/assets") return respond(response,await assets.upload(request,url.searchParams.get("kind"),access),201);
      const assetMatch=/^\/assets\/([a-f0-9-]{36})$/.exec(route);
      if(request.method==="GET" && assetMatch) {
        const {record,file}=await assets.file(assetMatch[1],access);
        if(url.searchParams.get("metadata")==="1") return respond(response,record);
        await streamMedia(request,response,file,assetTypes[record.kind].mime,undefined,access); return;
      }
      if (route.startsWith("/models")) {
        response.setHeader("cache-control", "no-store");
        if (!runtime.localSettingsAllowed(request)) throw new VideoError("模型管理仅允许本机页面或已认证启用的 Agent 访问。", 403);
        if (request.method === "GET" && route === "/models") return respond(response, await models.snapshot(access));
        if (request.method === "GET" && route === "/models/initialization") return respond(response, await models.downloadPlan(undefined,access));
        if (request.method === "POST" && route === "/models/initialize") {
          const body = await checkedReadBody(http, request, 4096, access);
          return respond(response, await service.exclusive(() => models.initializeModels(body,access),access));
        }
        if (request.method === "GET" && route === "/models/settings") return respond(response, models.directories());
        if (request.method === "PATCH" && route === "/models/settings") {
          const body = await checkedReadBody(http, request, 4096, access);
          return respond(response, await service.exclusive(() => models.configure(body,access),access));
        }
        if (request.method === "POST" && route === "/models/runtime") return respond(response, await service.exclusive(async () => {
          models.guard();
          await fs.mkdir(runtime.componentRoot, { recursive: true });
          await fs.copyFile(new URL("./install-runtime.ps1", import.meta.url), path.join(runtime.componentRoot, "install-runtime.ps1"));
          return models.installRuntime(access);
        },access));
        const download = /^\/models\/([a-z0-9-]+)\/download$/.exec(route);
        if (request.method === "POST" && download) return respond(response, await service.exclusive(() => models.download(download[1],access),access));
        throw new VideoError("模型管理接口不存在。", 404);
      }
      if (request.method === "GET" && route === "/status") return respond(response, service.snapshot());
      if (request.method === "POST" && route === "/runtime/start") {
        if (models.flight) throw new VideoError("请等待安装结束。", 409);
        return respond(response, await service.start(() => models.runtimeRoots(), async () => {
          if (models.flight) throw new VideoError("请等待安装结束。", 409);
          await models.assertStartable(access);
        },access));
      }
      if (request.method === "POST" && route === "/runtime/stop") return respond(response, await service.stop(access));
      if (request.method === "POST" && route === "/jobs") return respond(response,await service.submit(await checkedReadBody(http,request,25 * 1024 * 1024,access), request.headers["idempotency-key"],access),202);
      if (request.method === "GET" && route === "/jobs") return respond(response, { jobs: service.snapshot().jobs });
      const match = /^\/jobs\/([0-9a-f-]{36})(\/cancel|\/video|\/image)?$/.exec(route);
      const job = match && service.jobs.get(match[1]);
      if (!job) throw new VideoError("视频 API 或任务不存在。", 404);
      if (request.method === "GET" && !match[2]) return respond(response, service.view(job));
      if (request.method === "POST" && match[2] === "/cancel") return respond(response, await service.cancel(job.id,access));
      if (request.method === "GET" && (match[2] === "/video" || match[2] === "/image")) {
        if (job.status !== "succeeded") throw new VideoError("视频尚未生成。", 409);
        const file = await service.outputPath(job,access);
        const image = catalog.models.find(row=>row.id===job.model)?.mode === "image";
        if (match[2] !== (image ? "/image" : "/video")) throw new VideoError("结果类型不匹配。",404);
        await streamMedia(request,response,file,image ? "image/png" : "video/mp4",`${job.id}.${image ? "png" : "mp4"}`,access);
        return;
      }
      throw new VideoError("不支持此操作。", 405);
    }
    const unregister = http.registerRoutes(context.identity.instanceId, "manager.video.api", [tracker.wrap((request, url, response) => {
      if (!url.pathname.startsWith("/api/video/")) return false;
      dispatchVideoRequest(runtime,http,request,response,access => handle(request,url,response,access));
      return true;
    })], [{ routeId: "video", kind: "prefix", pathPrefix: "/api/video/" }]);
    return async () => { unregister(); assets.closed=true; await runtime.stopMediaProbe(); await models.close(); await service.close(); await tracker.stop(); };
  }, "video service");
} }).activate;
