import { definePlugin } from "@rabiroute/plugin-sdk";
import fs from "node:fs/promises";
import { checkedFs, checkedReadBody } from "./requestAccess.mjs";
import { streamMedia } from "./media.mjs";
import { VideoService, VideoError } from "./service.mjs";
import { VideoModels } from "./models.mjs";
import path from "node:path";
import { VideoAssets, assetTypes } from "./assets.mjs";
import { VideoProjects, handleProjects } from "./projects.mjs";
import { RemoteVideoCompute } from "./remoteCompute.mjs";

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
    const computeListeners = new Set();
    const computeStreams = new Set();
    const computeJobListeners = new Map();
    const publish = (name,data) => {
      http.publishManagerEvent("plugin_event", {instanceId:context.identity.instanceId,name,data});
      if (["video.models","video.changed"].includes(name)) for (const listener of computeListeners) listener(name);
      if (data?.jobId && ["video.changed","video.progress"].includes(name)) for (const listener of computeJobListeners.get(data.jobId) || []) listener();
    };
    const service = new VideoService(runtime, catalog, publish);
    await service.initialize();
    const assets = new VideoAssets(runtime); service.assets = assets;
    const computeAssets = new VideoAssets({...runtime, stateRoot:path.join(runtime.stateRoot,"compute"), inspectAsset:(id,kind,access)=>runtime.inspectAsset(id,kind,access,true)});
    service.computeAssets = computeAssets;
    service.remote = new RemoteVideoCompute(runtime, catalog, (name,data)=>http.publishManagerEvent("plugin_event", {instanceId:context.identity.instanceId,name,data}),service.jobs.values());
    const projects = new VideoProjects(runtime);
    if(!runtime.readOnly) { await fs.mkdir(runtime.componentRoot,{recursive:true}); await fs.copyFile(new URL("./inspect-media.py",import.meta.url),path.join(runtime.componentRoot,"inspect-media.py")); }
    const models = new VideoModels(runtime, catalog, () => publish("video.models",{}));
    await models.initialize();
    const computeStatus = () => {const {jobs,...status}=service.snapshot();return {...status,computeProtocol:1,frameAdaptationAvailable:service.frameAdaptationAvailable};};
    async function startLocal(access) {
      if (models.flight) throw new VideoError("请等待安装结束。",409);
      return service.start(()=>models.runtimeRoots(),async()=>{
        if (models.flight) throw new VideoError("请等待安装结束。",409);
        await models.assertStartable(access);
      },access);
    }
    const tracker = new http.ManagerPluginRequestTracker();
    async function handle(request, url, response, access) {
      const fs = checkedFs(access); access?.assert();
      const respond = (response, value, status = 200) => { access?.assert(); return http.jsonResponse(response, status, value); };
      const route = url.pathname.slice("/api/video".length);
      const deviceId = url.searchParams.get("computeDeviceId") || "";
      if (deviceId.length > 200) throw new VideoError("模型服务电脑编号无效。");
      if (await handleProjects(projects,request,url,response,http,access)) return;
      if (route.startsWith("/compute/")) {
        if (request.method === "GET" && route === "/compute/events") {
          if (computeListeners.size >= 64) throw new VideoError("模型状态订阅过多。",429);
          access?.assert();response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store"});
          const send = name => {
            try {access?.assert();response.write(`event: compute\ndata: ${JSON.stringify({name})}\n\n`);}
            catch {response.destroy();}
          };
          computeListeners.add(send);computeStreams.add(response);send("video.models");
          const heartbeat = setInterval(()=>send("heartbeat"),20000);
          response.once("close",()=>{clearInterval(heartbeat);computeListeners.delete(send);computeStreams.delete(response);});
          return;
        }
        await service.reapCompute(access);
        if (request.method === "GET" && route === "/compute/status") return respond(response,computeStatus());
        if (request.method === "POST" && route === "/compute/runtime/start") {await startLocal(access);return respond(response,computeStatus());}
        if (request.method === "POST" && route === "/compute/runtime/stop") {await service.stop(access);return respond(response,computeStatus());}
        if (request.method === "POST" && route === "/compute/assets") return respond(response,await computeAssets.upload(request,url.searchParams.get("kind"),access),201);
        const asset = /^\/compute\/assets\/([a-f0-9-]{36})$/.exec(route);
        if (request.method === "DELETE" && asset) {
          if ([...service.jobs.values()].some(job=>!catalog.states[job.status].terminal && job.references?.includes(asset[1]))) throw new VideoError("推理仍在使用该输入。",409);
          await computeAssets.remove(asset[1],access); return respond(response,{removed:true});
        }
        if (request.method === "POST" && route === "/compute/jobs") return respond(response,await service.submit(await checkedReadBody(http,request,25*1024*1024,access),request.headers["idempotency-key"],access,{computeOnly:true}),202);
        const match = /^\/compute\/jobs\/([a-f0-9-]{36})(\/image|\/video|\/events)?$/.exec(route);
        const job = match && service.jobs.get(match[1]);
        if (!job?.computeOnly) throw new VideoError("推理接口或回执不存在。",404);
        if (match[2] === "/events" && request.method === "GET") {
          if (computeStreams.size >= 64) throw new VideoError("推理订阅过多。",429);
          access?.assert();response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store"});
          const send = () => {
            try {
              access?.assert();response.write(`event: progress\ndata: ${JSON.stringify(service.view(job))}\n\n`);
              if (catalog.states[job.status].terminal) response.end();
            } catch {response.destroy();}
          };
          const listeners = computeJobListeners.get(job.id) || new Set();computeJobListeners.set(job.id,listeners);
          listeners.add(send);computeStreams.add(response);
          const heartbeat=setInterval(()=>{try {access?.assert();response.write(": heartbeat\n\n");}catch {response.destroy();}},20000);
          response.once("close",()=>{clearInterval(heartbeat);listeners.delete(send);if(!listeners.size)computeJobListeners.delete(job.id);computeStreams.delete(response);});
          send();return;
        }
        if (!match[2] && request.method === "GET") return respond(response,service.view(job));
        if (!match[2] && request.method === "DELETE") return respond(response,await service.removeCompute(job.id,access));
        if (match[2] && request.method === "GET") {
          if (job.outputPurged) throw new VideoError("推理结果已清理，原任务不会重新执行。",410);
          const image = catalog.models.find(row=>row.id===job.model)?.mode === "image";
          if (job.status !== "succeeded" || match[2] !== (image ? "/image" : "/video")) throw new VideoError("推理结果未就绪或类型不匹配。",409);
          await streamMedia(request,response,await service.outputPath(job,access),image?"image/png":"video/mp4",undefined,access); return;
        }
        throw new VideoError("不支持此操作。",405);
      }
      if(request.method==="POST" && route==="/assets") return respond(response,await assets.upload(request,url.searchParams.get("kind"),access,deviceId ? (kind,file,guard)=>service.remote.inspect(deviceId,kind,file,guard) : undefined),201);
      const assetMatch=/^\/assets\/([a-f0-9-]{36})$/.exec(route);
      if(request.method==="GET" && assetMatch) {
        const {record,file}=await assets.file(assetMatch[1],access);
        if(url.searchParams.get("metadata")==="1") return respond(response,record);
        await streamMedia(request,response,file,assetTypes[record.kind].mime,undefined,access); return;
      }
      if (route.startsWith("/models")) {
        response.setHeader("cache-control", "no-store");
        if (!runtime.localSettingsAllowed(request)) throw new VideoError("模型管理仅允许本机页面或已认证启用的 Agent 访问。", 403);
        if (deviceId) {
          const body = ["POST","PATCH"].includes(request.method) ? await checkedReadBody(http,request,4096,access) : undefined;
          return respond(response,await service.remote.json(deviceId,route,{method:request.method,...(body===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(body)})},access));
        }
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
      if (request.method === "GET" && route === "/status") return respond(response, await service.snapshotFor(deviceId,access));
      if (request.method === "POST" && route === "/runtime/start") {
        if (deviceId) return respond(response,await service.startRemote(deviceId,access));
        return respond(response,await startLocal(access));
      }
      if (request.method === "POST" && route === "/runtime/stop") {
        if (deviceId) { await service.remote.json(deviceId,"/compute/runtime/stop",{method:"POST"},access); return respond(response,await service.snapshotFor(deviceId,access)); }
        return respond(response, await service.stop(access));
      }
      if (request.method === "POST" && route === "/jobs") return respond(response,await service.submit(await checkedReadBody(http,request,25 * 1024 * 1024,access), request.headers["idempotency-key"],access,{deviceId}),202);
      if (request.method === "GET" && route === "/jobs") return respond(response, { jobs: service.snapshot().jobs });
      const match = /^\/jobs\/([0-9a-f-]{36})(\/cancel|\/video|\/image)?$/.exec(route);
      const job = match && service.jobs.get(match[1]);
      if (!job || job.computeOnly) throw new VideoError("视频 API 或任务不存在。", 404);
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
    return async () => { unregister(); assets.closed=true; computeAssets.closed=true; for (const response of computeStreams) response.end(); await runtime.stopMediaProbe(); await models.close(); await service.close(); await tracker.stop(); };
  }, "video service");
} }).activate;
