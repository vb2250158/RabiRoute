import fs from "fs";
import path from "path";
import { spawn } from "child_process";

let logger = null;
let currentConfig = {
  gatewayRoot: "C:\\Path\\To\\RabiRoute",
  managerUrl: "http://127.0.0.1:8790",
  managerPort: 8790
};
let managerProcess = null;

function gatewayConfigPath() {
  return path.join(currentConfig.gatewayRoot, "data", "gateways.json");
}

function gatewayExamplePath() {
  return path.join(currentConfig.gatewayRoot, "examples", "data", "gateways.json");
}

function gatewayExampleDataPath() {
  return path.join(currentConfig.gatewayRoot, "examples", "data");
}

function defaultGatewayConfig() {
  return {
    gateways: [
      {
        id: "default-main",
        name: "默认 QQ 网关",
        enabled: true,
        messageAdapters: ["napcat", "heartbeat"],
        gatewayPort: 8789,
        napcatHttpUrl: "http://127.0.0.1:3000",
        napcatAccessToken: "",
        heartbeatIntervalSeconds: 900,
        heartbeatMessage: "定时心跳巡检：请检查最近消息、项目缓存、等待项和下一步动作。",
        codexThreadName: "QQ 消息监听",
        codexCwd: "",
        rolesDir: "./data/default-main/roles",
        agentRoleId: "",
        agentRoleFile: "persona.md",
        agentAdapters: ["codexDesktop"],
        dataDir: "./data/default-main",
        routeVariables: {},
        messageAdapterType: "napcat",
        routeName: "默认路由",
        roleRouteNames: {}
      }
    ]
  };
}

function ensureGatewayConfig() {
  const configPath = gatewayConfigPath();
  if (fs.existsSync(configPath)) {
    return;
  }
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(gatewayExamplePath())) {
    fs.cpSync(gatewayExampleDataPath(), dir, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
    return;
  }
  fs.writeFileSync(configPath, JSON.stringify(defaultGatewayConfig(), null, 2), "utf-8");
}

function readGatewayConfig() {
  ensureGatewayConfig();
  return JSON.parse(fs.readFileSync(gatewayConfigPath(), "utf-8"));
}

function writeGatewayConfig(config) {
  if (!Array.isArray(config.gateways)) {
    throw new Error("gateways 必须是数组");
  }
  for (const gateway of config.gateways) {
    if (!gateway.id || !/^[a-zA-Z0-9_-]+$/.test(gateway.id)) {
      throw new Error(`无效的网关 ID：${gateway.id}`);
    }
    if (!Number.isInteger(Number(gateway.gatewayPort)) || Number(gateway.gatewayPort) <= 0) {
      throw new Error(`无效的网关端口：${gateway.gatewayPort}`);
    }
    gateway.gatewayPort = Number(gateway.gatewayPort);
    gateway.enabled = gateway.enabled !== false;
    const agentAdapters = Array.isArray(gateway.agentAdapters) ? gateway.agentAdapters : ["codexDesktop"];
    gateway.agentAdapters = [...new Set(agentAdapters.filter((item) => item === "codexDesktop" || item === "codexApp"))];
  }
  fs.writeFileSync(gatewayConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

function napcatConfigDir() {
  return path.resolve(path.dirname(currentConfigPath), "..", "..");
}

let currentConfigPath = "";

function readOneBotNetworkOptions() {
  const configDir = napcatConfigDir();
  const files = fs.existsSync(configDir)
    ? fs.readdirSync(configDir).filter((name) => /^onebot11.*\.json$/i.test(name))
    : [];
  const httpServers = [];
  const websocketClients = [];

  for (const file of files) {
    const fullPath = path.join(configDir, file);
    try {
      const json = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      const network = json.network || {};
      for (const server of network.httpServers || []) {
        if (server.enable === false) continue;
        const host = server.host || "127.0.0.1";
        const port = Number(server.port || 0);
        if (!port) continue;
        httpServers.push({
          label: `${server.name || "HTTP 服务器"} (${host}:${port})`,
          value: `http://${host}:${port}`,
          file
        });
      }
      for (const client of network.websocketClients || []) {
        if (client.enable === false || !client.url) continue;
        let port = "";
        try {
          port = String(new URL(client.url).port || "");
        } catch {
          const match = String(client.url).match(/:(\d+)(?:\/|$)/);
          port = match?.[1] || "";
        }
        if (!port) continue;
        websocketClients.push({
          label: `${client.name || "WebSocket 客户端"} (${client.url})`,
          value: port,
          url: client.url,
          file
        });
      }
    } catch (error) {
      logger?.warn(`读取 OneBot 配置失败: ${fullPath}`, error);
    }
  }

  return {
    httpServers,
    websocketClients,
    adapters: {
      napcat: {
        httpServers,
        websocketClients
      },
      webhook: {
        listeners: []
      },
      heartbeat: {},
      disabled: {}
    }
  };
}

async function fetchManager(pathname, options = {}) {
  const url = `${currentConfig.managerUrl.replace(/\/$/, "")}${pathname}`;
  const response = await fetch(url, options);
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Keep text body for redirects or html responses.
  }
  if (!response.ok) {
    throw new Error(`管理器请求失败 ${pathname}：HTTP ${response.status} ${text}`);
  }
  return body;
}

function startManagerProcess() {
  if (managerProcess && !managerProcess.killed) {
    return;
  }
  managerProcess = spawn("npm", ["run", "manager"], {
    cwd: currentConfig.gatewayRoot,
    env: {
      ...process.env,
      GATEWAY_MANAGER_PORT: String(currentConfig.managerPort)
    },
    shell: true,
    windowsHide: true,
    stdio: "ignore"
  });
  managerProcess.unref();
  logger?.info(`RabiRoute 管理器已启动，pid=${managerProcess.pid ?? "未知"}`);
}

async function reloadManager() {
  return await fetchManager("/reload", {
    headers: {
      accept: "application/json"
    }
  });
}

const plugin_init = async (ctx) => {
  logger = ctx.logger;
  currentConfigPath = ctx.configPath;
  try {
    if (fs.existsSync(ctx.configPath)) {
      Object.assign(currentConfig, JSON.parse(fs.readFileSync(ctx.configPath, "utf-8")));
    }
  } catch (error) {
    logger?.warn("读取 RabiRoute 插件配置失败", error);
  }

  ctx.router.static("/static", "webui");

  const handleGetConfig = (_req, res) => {
    res.json({ code: 0, data: currentConfig });
  };
  ctx.router.get("/config", handleGetConfig);
  ctx.router.getNoAuth("/config", handleGetConfig);

  const handlePostConfig = (req, res) => {
    try {
      currentConfig = { ...currentConfig, ...req.body };
      fs.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
      fs.writeFileSync(ctx.configPath, JSON.stringify(currentConfig, null, 2), "utf-8");
      res.json({ code: 0, message: "已保存" });
    } catch (error) {
      res.status(500).json({ code: -1, message: error.message });
    }
  };
  ctx.router.post("/config", handlePostConfig);
  ctx.router.postNoAuth("/config", handlePostConfig);

  const handleGetGateways = async (_req, res) => {
    const config = readGatewayConfig();
    let manager = null;
    try {
      manager = await fetchManager("/api/gateways", { headers: { accept: "application/json" } });
    } catch (error) {
      manager = { error: error.message };
    }
    res.json({ code: 0, data: { config, manager } });
  };
  ctx.router.get("/gateways", handleGetGateways);
  ctx.router.getNoAuth("/gateways", handleGetGateways);

  const handleGetNetworkOptions = (_req, res) => {
    try {
      res.json({ code: 0, data: readOneBotNetworkOptions() });
    } catch (error) {
      res.status(500).json({ code: -1, message: error.message });
    }
  };
  ctx.router.get("/network-options", handleGetNetworkOptions);
  ctx.router.getNoAuth("/network-options", handleGetNetworkOptions);

  const handlePostGateways = async (req, res) => {
    try {
      writeGatewayConfig(req.body);
      let manager = null;
      try {
        manager = await reloadManager();
      } catch (error) {
        manager = { error: error.message };
      }
      res.json({ code: 0, data: { config: readGatewayConfig(), manager } });
    } catch (error) {
      res.status(400).json({ code: -1, message: error.message });
    }
  };
  ctx.router.post("/gateways", handlePostGateways);
  ctx.router.postNoAuth("/gateways", handlePostGateways);

  const handleStartManager = (_req, res) => {
    try {
      startManagerProcess();
      res.json({ code: 0, message: "管理器正在启动" });
    } catch (error) {
      res.status(500).json({ code: -1, message: error.message });
    }
  };
  ctx.router.post("/manager/start", handleStartManager);
  ctx.router.postNoAuth("/manager/start", handleStartManager);

  const handleGatewayAction = async (req, res) => {
    try {
      const { id, action } = req.params;
      if (!["start", "stop", "restart"].includes(action)) {
        res.status(400).json({ code: -1, message: "无效操作" });
        return;
      }
      await fetchManager(`/gateways/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      res.json({ code: 0, message: `已请求执行 ${action}` });
    } catch (error) {
      res.status(500).json({ code: -1, message: error.message });
    }
  };
  ctx.router.post("/gateways/:id/:action", handleGatewayAction);
  ctx.router.postNoAuth("/gateways/:id/:action", handleGatewayAction);

  ctx.router.page({
    path: "gateways",
    title: "RabiRoute",
    icon: "✦",
    htmlFile: "webui/gateways.html",
    description: "打开拉比路由独立控制台"
  });

  logger?.info("RabiRoute 插件已初始化");
};

const plugin_get_config = async () => currentConfig;

const plugin_set_config = async (ctx, config) => {
  currentConfig = { ...currentConfig, ...config };
  fs.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
  fs.writeFileSync(ctx.configPath, JSON.stringify(currentConfig, null, 2), "utf-8");
};

let plugin_config_ui = [];

const plugin_cleanup = async () => {
  logger?.info("RabiRoute 插件已清理");
};

export {
  plugin_init,
  plugin_get_config,
  plugin_set_config,
  plugin_config_ui,
  plugin_cleanup
};
