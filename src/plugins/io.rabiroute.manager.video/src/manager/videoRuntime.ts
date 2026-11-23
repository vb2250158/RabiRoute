import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import rawFs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateLocalModelDirectory as validateModelRoot } from "@rabiroute/host-api/shared/localModelDirectory";
import { localModelSettingsRequestAllowed } from "@rabiroute/host-api/manager/speechModelSettingsAccess";
import { recordDataMutationAudit, type DataMutationAuditRecord } from "@rabiroute/host-api/observability/dataMutationAudit";
import type { PluginIdentity } from "@rabiroute/host-api/plugin-kernel/types";
import type { ProcessLease, ProcessLeaseRegistry } from "@rabiroute/host-api/runtime/processLeaseRegistry";

export type VideoRequestAccess = { assert(): void; beforeMutation(): void; readonly denied: boolean; readonly mutationStarted: boolean };
export function createVideoRequestAccess(request: IncomingMessage): VideoRequestAccess {
  let denied = false, mutationStarted = false;
  const access = {
    get denied() { return denied; }, get mutationStarted() { return mutationStarted; },
    assert() {
      if (!denied) { try { assertTrustedLanAgentPrincipal(request); hasAuthenticatedConnectionRequest(request); } catch { denied = true; } }
      if (denied) throw Object.assign(new Error("Video request forbidden"), { status: 403, code: "VIDEO_REQUEST_FORBIDDEN" });
    },
    beforeMutation() { access.assert(); mutationStarted = true; }
  };
  access.assert(); return access;
}
function checkedFs(access?: VideoRequestAccess): typeof rawFs {
  if (!access) return rawFs;
  return new Proxy(rawFs, { get(target, key) {
    const operation = Reflect.get(target, key);
    if (typeof operation !== "function") return operation;
    return async (...args: unknown[]) => {
      const writing = ["mkdir", "writeFile", "open"].includes(String(key)) && (key !== "open" || args[1] !== "r");
      if (writing) access.beforeMutation(); else access.assert();
      let result;
      try { result = await operation(...args); } catch (error) { access.assert(); throw error; }
      try { access.assert(); } catch (error) { if (key === "open") await result.close().catch(() => {}); throw error; }
      return result;
    };
  } });
}
async function validateLocalModelRoot(value: unknown, access?: VideoRequestAccess) {
  access?.assert();
  const root = validateModelRoot(value, [], () => true);
  if (!root) return null;
  access?.beforeMutation();
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$d=Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID=' + [char]39 + $env:RABIROUTE_VIDEO_MODEL_DRIVE + [char]39); if($d.DriveType -eq 3){'fixed'}"], { encoding: "utf8", timeout: getTimeoutMs("backend.manager.videoRuntime.validateLocalModelRoot.promisify_execFile_.timeout", 5000), maxBuffer: 4096, windowsHide: true, env: { ...process.env, RABIROUTE_VIDEO_MODEL_DRIVE: root.slice(0, 2) } });
  access?.assert();
  if (stdout.trim() !== "fixed") throw new Error("Video models require a local fixed disk");
  return root;
}
async function validateWorkbenchLocalPath(directory:string) {
  const real=await rawFs.realpath(directory);
  if(process.platform!=="win32") {if(real.startsWith("\\\\"))throw new Error("工作台执行目录必须在本机。");return;}
  if(!/^[A-Za-z]:[\\/]/.test(directory)||!/^[A-Za-z]:[\\/]/.test(real))throw new Error("工作台执行目录不能指向网络或设备路径。");
  const drives=[...new Set([directory.slice(0,2),real.slice(0,2)])];
  const script="foreach($drive in ($env:RABIROUTE_WORKBENCH_DRIVES -split ',')){$disk=Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID=' + [char]39 + $drive + [char]39);if($disk.DriveType -ne 3){exit 1}};'fixed'";
  const {stdout}=await promisify(execFile)("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",timeout:5000,maxBuffer:4096,windowsHide:true,env:{...process.env,RABIROUTE_WORKBENCH_DRIVES:drives.join(",")}});
  if(stdout.trim()!=="fixed")throw new Error("工作台执行目录所在磁盘尚未核实为本机固定磁盘。");
}

/** Only the installed, fixed video component can be launched; API callers never supply commands. */
export function createVideoRuntime(rootDir: string, identity: PluginIdentity, leases: ProcessLeaseRegistry, readOnly = false, peerFetch?: (deviceId: string, pathname: string, init: RequestInit) => Promise<Response>) {
  const componentRoot = path.join(rootDir, "components", "video");
  const comfyRoot = path.join(componentRoot, "ComfyUI");
  let lease: ProcessLease | undefined;
  let endpoint = "";
  let starting: Promise<string> | undefined;
  let installer: ProcessLease | undefined;
  let mediaProbe: ProcessLease | undefined;
  let probesClosed = false;
  const exitListeners = new Set<() => void>();
  const workbenchProcesses = new Map<string, ProcessLease>();
  async function start(modelRoot?: string | string[], access?: VideoRequestAccess): Promise<string> {
    const fs = checkedFs(access); access?.assert();
    if(mediaProbe) throw new Error("请等待素材检查完成。");
    if (readOnly) throw new Error("视频服务在只读模式下不能启动。");
    if (lease && lease.child.exitCode === null && endpoint) return endpoint;
    if (starting) { const result = await starting; access?.assert(); return result; }
    starting = (async () => {
      const settings = JSON.parse(await fs.readFile(path.join(componentRoot, "runtime.json"), "utf8").catch(error => { access?.assert(); if (error.code === "ENOENT") return "{}"; throw error; })) as { pythonExecutable?: string };
      const python = settings.pythonExecutable || path.join(componentRoot, ".venv", "Scripts", "python.exe");
      if (!path.isAbsolute(python) || python.startsWith("\\\\") || path.basename(python).toLowerCase() !== "python.exe") throw new Error("视频 Python 运行环境无效，请重新运行安装脚本。");
      for (const target of [python, path.join(comfyRoot, "main.py")]) {
        try { await fs.access(target); } catch { access?.assert(); throw new Error("视频运行环境尚未安装，请先运行视频插件的 Install-RabiVideo.ps1。"); }
      }
      const realRoot = await fs.realpath(componentRoot);
      if (realRoot.startsWith("\\\\")) throw new Error("视频运行环境必须安装在本机磁盘。");
      const modelArguments: string[] = [];
      if (modelRoot) {
        const roots = [...new Set(Array.isArray(modelRoot) ? modelRoot : [modelRoot])];
        for (const root of roots) await validateLocalModelRoot(root, access);
        const config = path.join(componentRoot, "model-paths.json");
        // JSON is a YAML subset; paths are never interpolated into YAML or a command.
        const audit: Omit<DataMutationAuditRecord, "outcome"> = {
          group: "config.video", event: "video_model_paths_written", owner: "VideoRuntime", action: "write",
          target: { type: "video_model_paths", id: "model-paths" },
          dataSource: { kind: "file", id: "components/video/model-paths.json" },
          changes: [{ field: "modelRoot" }]
        };
        recordDataMutationAudit({ ...audit, outcome: "started" });
        try {
          await fs.writeFile(config, JSON.stringify(Object.fromEntries(roots.map((root, index) => [`rabi_media_${index}`, { base_path: root, is_default: true, diffusion_models: "diffusion_models", text_encoders: "text_encoders", vae: "vae", loras: "loras" }]))));
          recordDataMutationAudit({ ...audit, outcome: "committed" });
        } catch (error) {
          recordDataMutationAudit({ ...audit, outcome: "failed", result: "model_paths_write_failed" });
          throw error;
        }
        modelArguments.push("--extra-model-paths-config", config);
      }
      const port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        access?.beforeMutation();
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") { server.close(); reject(new Error("无法分配视频服务端口。")); return; }
          server.close(error => error ? reject(error) : resolve(address.port));
        });
      });
      const output = path.join(rootDir, "data", "video", "provider-output");
      const input = path.join(rootDir, "data", "video", "provider-input");
      const logs = path.join(rootDir, "logs", "video");
      await Promise.all([output, input, logs].map(directory => fs.mkdir(directory, { recursive: true })));
      const log = await fs.open(path.join(logs, `comfy-${Date.now()}.log`), "a");
      try {
        access?.beforeMutation();
        lease = leases.launch(identity, "video-comfyui", { kind: "spawn", command: python, args: [
          "-u", path.join(comfyRoot, "main.py"), "--listen", "127.0.0.1", "--port", String(port),
          "--input-directory", input, "--output-directory", output, "--disable-auto-launch", ...modelArguments
        ], options: { cwd: comfyRoot, windowsHide: true, stdio: ["ignore", log.fd, log.fd] } },
        { maxChildProcesses: 1, exclusiveAcrossOwners: true });
        void lease.settled.then(() => { for (const listener of exitListeners) listener(); });
      } finally { await log.close(); }
      endpoint = `http://127.0.0.1:${port}`;
      access?.assert(); return endpoint;
    })().finally(() => { starting = undefined; });
    return starting;
  }
  return Object.freeze({
    getTimeoutMs,
    machineId: process.env.COMPUTERNAME || process.env.HOSTNAME || identity.managerInstanceId,
    generation: identity.applicationGenerationId,
    workbenchRuntimeRoot: path.join(rootDir, "data", "workbench-runtime"),
    async workbenchBindings() {
      return JSON.parse(await rawFs.readFile(path.join(componentRoot, "workbench-bindings.json"), "utf8"));
    },
    validateWorkbenchRuntimeRoot:validateWorkbenchLocalPath,
    validateWorkbenchExecutable:validateWorkbenchLocalPath,
    async workbenchProjectRoot() {
      const settings=JSON.parse(await rawFs.readFile(path.join(componentRoot,"workbench-bindings.json"),"utf8").catch(error=>{if(error.code==="ENOENT")return "{}";throw error;}));
      if(settings.projectsRoot===undefined)return undefined;
      if(typeof settings.projectsRoot!=="string"||!path.isAbsolute(settings.projectsRoot))throw new Error("工作台项目根目录必须为绝对路径。");
      return path.normalize(settings.projectsRoot);
    },
    auditWorkbench(event: string, id: string, outcome: "started" | "committed" | "failed") {
      recordDataMutationAudit({ group:"config.video", event, owner:"Workbench", action:"write", target:{type:"workbench_run",id}, dataSource:{kind:"file",id:"data/workbench-runtime"}, outcome });
    },
    reportWorkbenchRead(operation: string, id: string, stages: Record<string, number>, failed: boolean) {
      recordDataMutationAudit({
        level: failed ? "warn" : "info", group: "config.video", event: "workbench_list_timing", owner: "WorkbenchProjects", action: "read",
        target: { type: "workbench_project", id }, dataSource: { kind: "file", id: "workbench_project_storage" },
        outcome: failed ? "failed" : "no_change", durationMs: stages.total, result: operation,
        changes: Object.entries(stages).filter(([stage]) => stage !== "total").map(([stage, ms]) => ({ field: `${stage}Ms`, to: ms })),
      });
    },
    reportWorkbenchIndexFailure({ projectId, canvasId, revision, error }: { projectId: string; canvasId: string; revision: number; error: unknown }) {
      recordDataMutationAudit({
        level: "warn", group: "config.video", event: "workbench_canvas_summary_pending", owner: "WorkbenchProjects", action: "write",
        target: { type: "workbench_canvas", id: canvasId }, dataSource: { kind: "file", id: "workbench_canvas_summary" },
        outcome: "failed", after: { revision: String(revision) }, changes: [{ field: "projectId", to: projectId }], error,
      });
    },
    launchWorkbenchProcess(request: { attemptId:string; executable:string; argv:string[]; cwd:string; env:Record<string,string>; timeoutMs:number; stdin?:string }, output: (stream:string, text:string)=>void|Promise<void>) {
      if (readOnly) throw new Error("当前服务只读。");
      if (workbenchProcesses.has(request.attemptId)) throw new Error("此 attempt 已有执行租约。");
      const owned = leases.launch(identity, `workbench:${request.attemptId}`, {kind:"spawn",command:request.executable,args:request.argv,
        options:{cwd:request.cwd,env:request.env,shell:false,windowsHide:true,stdio:[request.stdin === undefined ? "ignore" : "pipe","pipe","pipe"]}}, {exclusiveAcrossOwners:true});
      workbenchProcesses.set(request.attemptId,owned);
      // Job-empty notification can precede Node's close event and exit-code projection.
      // Join both owners before publishing a completion receipt or validating outputs.
      const closed=new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>(resolve=>owned.child.once("close",(exitCode,signal)=>resolve({exitCode,signal})));
      owned.child.stdout?.setEncoding("utf8");owned.child.stderr?.setEncoding("utf8");
      const outputTasks=new Set<Promise<void>>();let outputError=false;
      const observe=(stream:typeof owned.child.stdout,name:string)=>stream?.on("data",chunk=>{
        if(outputError)return;
        stream.pause();
        const task=Promise.resolve().then(()=>output(name,String(chunk))).then(()=>{},()=>{outputError=true;void leases.terminate(owned).catch(()=>{});}).finally(()=>{outputTasks.delete(task);stream.resume();});
        outputTasks.add(task);
      });
      observe(owned.child.stdout,"stdout");observe(owned.child.stderr,"stderr");
      let inputError = false;
      if (request.stdin !== undefined) {
        const input = owned.child.stdin;
        if (!input) inputError = true;
        else {
          input.on("error", () => { inputError = true; });
          input.end(request.stdin, "utf8");
        }
      }
      let timeout = false;
      const timer = setTimeout(()=>{timeout=true;void leases.terminate(owned).catch(()=>{});}, request.timeoutMs);
      const settled = Promise.all([owned.settled,closed]).then(async([,result])=>{await Promise.all([...outputTasks]);return {...result,timedOut:timeout,outputError,inputError,leaseId:owned.id,terminated:true};}).finally(()=>{
        clearTimeout(timer);
        if(workbenchProcesses.size>64)for(const [id,lease]of workbenchProcesses){if(!leases.list(identity).some(active=>active.id===lease.id))workbenchProcesses.delete(id);if(workbenchProcesses.size<=64)break;}
      });
      return {id:owned.id,settled,cancel:()=>leases.terminate(owned)};
    },
    queryWorkbenchProcess(attemptId:string) {
      const owned=workbenchProcesses.get(attemptId);
      if(!owned)return {state:"unknown"};
      return {state:leases.list(identity).some(lease=>lease.id===owned.id)?"running":"exited",leaseId:owned.id,exitCode:owned.child.exitCode};
    },
    stateRoot: path.join(rootDir, "data", "video"),
    readOnly,
    componentRoot,
    defaultModelRoot: path.join(comfyRoot, "models"),
    requestAccess: createVideoRequestAccess,
    localSettingsAllowed: localModelSettingsRequestAllowed,
    validateModelRoot: validateLocalModelRoot,
    peerFetch: (deviceId: string, pathname: string, init: RequestInit) => {
      if (!peerFetch) throw new Error("模型服务电脑连接不可用。");
      return peerFetch(deviceId, pathname, init);
    },
    async inspectAsset(id: string, kind: string, access?: VideoRequestAccess, compute = false) {
      const fs = checkedFs(access); access?.assert();
      const extensions: Record<string,string> = {image:"png",video:"mp4",audio:"wav"};
      if (readOnly || probesClosed || mediaProbe || installer || starting || !/^[a-f0-9-]{36}$/.test(id) || !Object.hasOwn(extensions,kind)) throw new Error("Invalid media inspection request");
      const settings = JSON.parse(await fs.readFile(path.join(componentRoot,"runtime.json"),"utf8")) as {pythonExecutable:string};
      const python = settings.pythonExecutable;
      if (typeof python !== "string" || !path.isAbsolute(python) || python.startsWith("\\\\") || path.basename(python).toLowerCase() !== "python.exe") throw new Error("视频 Python 运行环境无效。");
      const script = path.join(componentRoot,"inspect-media.py");
      const file = path.join(rootDir,"data","video",...(compute ? ["compute"] : []),"assets",`${id}.${extensions[kind]}`);
      let output = "";
      if (probesClosed || mediaProbe) throw new Error("Media inspection is stopping or busy");
      access?.beforeMutation();
      mediaProbe = leases.launch(identity,"video-media-probe",{kind:"spawn",command:python,args:["-I",script,file,kind],options:{windowsHide:true,stdio:["ignore","pipe","ignore"]}},{maxChildProcesses:2,exclusiveAcrossOwners:true});
      const owned = mediaProbe;
      owned.child.stdout?.on("data", chunk => { if(output.length<8192) output += String(chunk); });
      const timer = setTimeout(()=> { void leases.terminate(owned); },getTimeoutMs("deadline.manager.videoRuntime.inspectAsset", 20000));
      try { await owned.settled; access?.assert(); if(owned.child.exitCode!==0 || output.length>8192) throw new Error("素材格式、尺寸或时长不符合要求。"); return JSON.parse(output); }
      finally { clearTimeout(timer); mediaProbe=undefined; }
    },
    async stopMediaProbe() { probesClosed = true; if(mediaProbe) await leases.terminate(mediaProbe); },
    async installed(access?: VideoRequestAccess) {
      const fs = checkedFs(access); access?.assert();
      const settings = JSON.parse(await fs.readFile(path.join(componentRoot, "runtime.json"), "utf8").catch(error => { access?.assert(); if (error.code === "ENOENT") return "{}"; throw error; })) as { pythonExecutable?: string };
      return Promise.all([settings.pythonExecutable || path.join(componentRoot, ".venv", "Scripts", "python.exe"), path.join(comfyRoot, "main.py")].map(file => fs.access(file).then(() => true, () => { access?.assert(); return false; }))).then(values => { access?.assert(); return values.every(Boolean); });
    },
    async install(access?: VideoRequestAccess) {
      const fs = checkedFs(access); access?.assert();
      if (readOnly || installer || lease?.child.exitCode === null) throw new Error("Video runtime is busy or read-only");
      const script = path.join(componentRoot, "install-runtime.ps1");
      // The plugin writes only its bundled installer to this fixed component location.
      const logs = path.join(rootDir, "logs", "video");
      await fs.mkdir(logs, { recursive: true });
      const log = await fs.open(path.join(logs, `install-${Date.now()}.log`), "a");
      try {
        access?.beforeMutation();
        installer = leases.launch(identity, "video-installer", { kind:"spawn",command:"powershell.exe",args:["-NoProfile", "-NonInteractive", "-File", script, "-ComponentRoot", componentRoot], options:{ cwd: componentRoot, windowsHide: true, stdio: ["ignore", log.fd, log.fd] } }, { maxChildProcesses: 1, exclusiveAcrossOwners: true });
        await installer.settled; access?.assert();
        if (installer.child.exitCode !== 0) throw new Error("Video runtime installation failed");
      } finally { installer = undefined; await log.close(); }
    },
    async stopInstaller() { if (installer) await leases.terminate(installer); },
    start,
    alive: () => Boolean(lease && lease.child.exitCode === null),
    onExit(listener: () => void) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    async stop(access?: VideoRequestAccess) {
      access?.assert();
      await starting?.catch(() => {});
      access?.assert();
      if (lease) { access?.beforeMutation(); await leases.terminate(lease); access?.assert(); }
      lease = undefined;
      endpoint = "";
    }
  });
}
