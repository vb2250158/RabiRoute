import fs from "fs";
import path from "path";

let logger = null;
let currentConfig = {
  managerUrl: ""
};

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
  const managerUrl = String(currentConfig.managerUrl || "").trim().replace(/\/$/, "");
  if (!managerUrl) throw new Error("请先从 RabiRoute Host 状态中复制当前 RibiWebGUI 地址。");
  const url = `${managerUrl}${pathname}`;
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
    try {
      const payload = await fetchManager("/gateways", { headers: { accept: "application/json" } });
      res.json(payload);
    } catch (error) {
      res.status(500).json({ code: -1, message: error.message });
    }
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
      const payload = await fetchManager("/gateways", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body)
      });
      res.json(payload);
    } catch (error) {
      res.status(400).json({ code: -1, message: error.message });
    }
  };
  ctx.router.post("/gateways", handlePostGateways);
  ctx.router.postNoAuth("/gateways", handlePostGateways);

  const handleOpenConfigFile = async (req, res) => {
    try {
      const query = new URLSearchParams();
      if (req.query.type) query.set("type", String(req.query.type));
      if (req.query.gatewayId) query.set("gatewayId", String(req.query.gatewayId));
      if (req.query.roleId) query.set("roleId", String(req.query.roleId));
      const result = await fetchManager(`/open-config-file?${query.toString()}`, { method: "POST" });
      res.json(result);
    } catch (error) {
      res.status(500).json({ code: -1, message: error.message });
    }
  };
  ctx.router.post("/open-config-file", handleOpenConfigFile);
  ctx.router.postNoAuth("/open-config-file", handleOpenConfigFile);

  const handleGatewayAction = async (req, res) => {
    try {
      const { id, action } = req.params;
      if (!["start", "stop", "restart", "delete"].includes(action)) {
        res.status(400).json({ code: -1, message: "无效操作" });
        return;
      }
      const result = await fetchManager(`/gateways/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      res.json(action === "delete" ? result : { code: 0, message: `已请求执行 ${action}` });
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
