import { getTimeoutMs } from "../shared/timeoutSettings.js";
import rawFs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateModelRoot } from "./speechModelSettings.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { recordDataMutationAudit, type DataMutationAuditRecord } from "../observability/dataMutationAudit.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import type { ProcessLease, ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";

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
        lease = leases.launch(identity, "video-comfyui", () => spawn(python, [
          "-u", path.join(comfyRoot, "main.py"), "--listen", "127.0.0.1", "--port", String(port),
          "--input-directory", input, "--output-directory", output, "--disable-auto-launch", ...modelArguments
        ], { cwd: comfyRoot, windowsHide: true, stdio: ["ignore", log.fd, log.fd] }),
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
      mediaProbe = leases.launch(identity,"video-media-probe",()=>spawn(python,["-I",script,file,kind],{windowsHide:true,stdio:["ignore","pipe","ignore"]}),{maxChildProcesses:2,exclusiveAcrossOwners:true});
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
        installer = leases.launch(identity, "video-installer", () => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-ComponentRoot", componentRoot], { cwd: componentRoot, windowsHide: true, stdio: ["ignore", log.fd, log.fd] }), { maxChildProcesses: 1, exclusiveAcrossOwners: true });
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
