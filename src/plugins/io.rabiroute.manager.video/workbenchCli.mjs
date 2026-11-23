import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const probe = promisify(execFile);
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,119}$/;
const copyEnvironment = /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|PATHEXT|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|CODEX_HOME|CODEBUDDY_CONFIG_DIR|CODEBUDDY_API_KEY|OPENAI_API_KEY|HTTPS?_PROXY|NO_PROXY)$/i;
const networkEnvironment = /^(CODEBUDDY_API_KEY|OPENAI_API_KEY|HTTPS?_PROXY|NO_PROXY)$/i;

const providers = {
  workbuddy: { label: "WorkBuddy CLI", installUrl: "https://www.codebuddy.cn/docs/cli/installation" },
  codex: { label: "Codex CLI", installUrl: "https://learn.chatgpt.com/docs/codex/cli" },
};

async function installedFile(candidates) {
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (!path.isAbsolute(candidate) || candidate.startsWith("\\\\")) continue;
    try { if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate); }
    catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error; }
  }
}

async function npmWorkbuddy() {
  if (!process.env.APPDATA) return;
  const name = "@tencent-ai/codebuddy-code";
  const folder = path.join(process.env.APPDATA,"npm","node_modules",name);
  try {
    const manifest = path.join(folder,"package.json");
    if ((await fs.stat(manifest)).size > 256 * 1024) return;
    const pkg = JSON.parse(await fs.readFile(manifest,"utf8"));
    if (pkg.name !== name || typeof pkg.bin?.codebuddy !== "string" || path.isAbsolute(pkg.bin.codebuddy)) return;
    const entry = await installedFile([path.resolve(folder,pkg.bin.codebuddy)]);
    if (!entry) return;
    const relative = path.relative(await fs.realpath(folder),entry);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".."+path.sep)) return;
    return { executable: process.execPath, prefix: [entry] };
  } catch { return undefined; }
}

function executablePaths(name, windows) {
  const search = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute);
  return search.map(root => path.join(root, windows ? `${name}.exe` : name));
}

async function discover(id) {
  const windows = process.platform === "win32";
  if (id === "codex") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const vendor = `node_modules/@openai/codex-win32-${arch}/vendor/${target}/bin/codex.exe`;
    const npmRoot = process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex");
    const executable = await installedFile([
      ...executablePaths("codex", windows),
      windows && npmRoot && path.join(npmRoot, vendor),
      windows && npmRoot && path.join(npmRoot, "vendor", target, "bin", "codex.exe"),
    ]);
    return executable && { executable, prefix: [] };
  }
  const executable = await installedFile(executablePaths("codebuddy", windows));
  if (executable) return { executable, prefix: [] };
  const launcher = await installedFile([
    windows && process.env.ProgramFiles && path.join(process.env.ProgramFiles, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
    process.platform === "darwin" && "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
  ]);
  return launcher ? { executable: process.execPath, prefix: [launcher], bundled: true } : windows ? npmWorkbuddy() : undefined;
}

function cliEnvironment(id, command, detection = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value && copyEnvironment.test(key) && (
    (id === "codex" || !/^OPENAI_API_KEY$/i.test(key)) && (id === "workbuddy" || !/^CODEBUDDY_API_KEY$/i.test(key)) &&
    (!detection || !networkEnvironment.test(key))
  )));
  if (id === "workbuddy") env.DISABLE_AUTOUPDATER = "1";
  if (command.bundled) env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = "1";
  return env;
}

export function workbuddyModels(help) {
  const ids = help.match(/--model <model>[\s\S]{0,200}?supported:\s*\(([^)]{1,4000})\)/i)?.[1];
  return [...new Set(ids?.split(",").map(id => id.replace(/\s/g, "")).filter(id => modelId.test(id)) ?? [])]
    .map(id => ({ id, label: id }));
}

async function codexModels() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const file = path.join(home, "models_cache.json");
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) return [];
    const { models } = JSON.parse(await fs.readFile(file, "utf8"));
    return (Array.isArray(models) ? models : []).filter(model => model?.visibility === "list" && typeof model.slug === "string" && modelId.test(model.slug))
      .map(model => ({ id: model.slug, label: String(model.display_name || model.slug).slice(0, 120) }));
  } catch { return []; }
}

async function workbuddyPanelKey(legacyTools) {
  if (typeof legacyTools !== "string" || !path.isAbsolute(legacyTools)) throw new Error("工作区缺少旧流程工具目录。");
  const directory = await fs.realpath(legacyTools);
  const target = await fs.realpath(path.join(directory,"workflow-gui","local.json"));
  const relative = path.relative(directory,target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".."+path.sep) || (await fs.stat(target)).size > 1024 * 1024)
    throw new Error("WorkBuddy 授权文件不在执行电脑配置的工具目录内。");
  const { apiKey } = JSON.parse(await fs.readFile(target,"utf8"));
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new Error("WorkBuddy 授权文件没有可用凭据。");
  return apiKey.trim();
}

async function inspectCli(id, validateExecutable) {
  const command = await discover(id);
  const provider = { id, ...providers[id], installed: Boolean(command), ready: false, models: [] };
  if (!command) return { provider };
  try {
    for (const file of [command.executable, ...command.prefix]) await validateExecutable?.(file);
    const env = cliEnvironment(id, command, true);
    const options = { env, cwd: os.homedir(), windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 };
    if (id === "workbuddy") {
      const { stdout } = await probe(command.executable, [...command.prefix, "--help"], options);
      provider.models = workbuddyModels(stdout);
    } else {
      const [, models] = await Promise.all([
        probe(command.executable, ["--version"], options),
        codexModels(),
      ]);
      provider.models = models;
    }
    provider.ready = true;
  } catch { return { provider }; }
  return { provider, command };
}

export function createWorkbenchCliCatalog({ validateExecutable } = {}) {
  let pending, expiresAt = 0, scanning = false;
  const load = refresh => {
    if (pending && (scanning || !refresh && expiresAt > Date.now())) return pending;
    scanning = true;
    expiresAt = Date.now() + 15_000;
    pending = Promise.all(Object.keys(providers).map(id => inspectCli(id, validateExecutable))).finally(() => { scanning = false; });
    pending.catch(() => { expiresAt = 0; });
    return pending;
  };
  return {
    async list(refresh = false) { return { providers: (await load(refresh)).map(item => item.provider) }; },
    async resolve(selection, cwd, output, options = {}) {
      const selected = (await load()).find(item => item.provider.id === selection.provider);
      if (!selected?.command || !selected.provider.ready) throw new Error("所选 Agent 未安装或无法启动。请在工作台的 Agent 设置中检查。");
      const model = selection.model;
      const legacyPanelAuth = selection.provider === "workbuddy" && options.legacyPanelAuth === true;
      if (model && (!modelId.test(model) || !selected.provider.models.some(item => item.id === model || legacyPanelAuth && item.id === `custom-local:${model}`)))
        throw new Error("选择的模型不在该 CLI 当前的模型列表中。");
      const { command } = selected;
      for (const file of [command.executable, ...command.prefix]) await validateExecutable?.(file);
      const env = cliEnvironment(selection.provider, command);
      if (legacyPanelAuth && !env.CODEBUDDY_API_KEY) {
        try { env.CODEBUDDY_API_KEY = await workbuddyPanelKey(options.legacyTools); }
        catch { throw new Error("工作区配置的 WorkBuddy 面板授权不可用。"); }
      }
      const argv = [...command.prefix];
      if (selection.provider === "codex") {
        argv.push("exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", cwd);
        if (output && output !== cwd) argv.push("--add-dir", output);
        if (model) argv.push("--model", model);
        argv.push("-");
      } else {
        const tools = "Read,Write,Edit,Glob,Grep,WebFetch,WebSearch" + (options.allowShell === true ? ",Bash" : "");
        argv.push("-p", "--output-format", "stream-json", "--port", "0", "--no-session-persistence",
          "--permission-mode", options.allowShell === true ? "dontAsk" : "acceptEdits", "--allowedTools", tools, "--tools", tools);
        if (output && output !== cwd) argv.push("--add-dir", output);
        if (model) argv.push("--model", model);
      }
      return { executable: command.executable, argv, cwd, env };
    },
  };
}

export function readCliEvent(provider, text) {
  let event;
  try { event = JSON.parse(text); } catch { return undefined; }
  if (provider === "codex" && event.type === "item.completed" && event.item?.type === "agent_message") {
    return { text: event.item.text };
  }
  if (provider === "workbuddy" && event.type === "result") {
    const authenticationRequired = /authentication required|not logged in|please use \/login|未登录/i.test(String(event.result ?? ""));
    return { completed: !event.is_error && event.subtype === "success" && !authenticationRequired, text: event.result, authenticationRequired };
  }
  if (provider === "codex" && ["turn.completed", "turn.failed", "error"].includes(event.type)) {
    return { completed: event.type === "turn.completed" };
  }
}
