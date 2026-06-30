import fs from "node:fs";
import path from "node:path";
import type { MessageAdapterType } from "../adapters/messageAdapter.js";
import type { MessageAdapterScanResult } from "./webhookLikeScans.js";

export type WeComScanRuntime = {
  definition: {
    id: string;
    name?: string;
    wecomBotId?: string;
    wecomBotSecret?: string;
    wecomWsUrl?: string;
  };
  gatewayStatus?: Record<string, any>;
};

export type WeComScanContext<Runtime extends WeComScanRuntime = WeComScanRuntime> = {
  rootDir: string;
  adapterRuntimes(type: MessageAdapterType): Runtime[];
  routeHasRecentMessages(runtime: Runtime, type: MessageAdapterType): boolean;
};

function packageInstalled(rootDir: string): boolean {
  if (fs.existsSync(path.join(rootDir, "node_modules", "@wecom", "aibot-node-sdk", "package.json"))) {
    return true;
  }
  for (const fileName of ["package.json", "package-lock.json"]) {
    const filePath = path.join(rootDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      return fs.readFileSync(filePath, "utf8").includes("\"@wecom/aibot-node-sdk\"");
    } catch {
      return false;
    }
  }
  return false;
}

function statusFor(runtime: WeComScanRuntime): Record<string, any> {
  return runtime.gatewayStatus?.messageAdapters?.wecom ?? runtime.gatewayStatus?.wecom ?? {};
}

export async function scanWeComEndpoint<Runtime extends WeComScanRuntime>(ctx: WeComScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const runtimes = ctx.adapterRuntimes("wecom");
  const configuredRuntime = runtimes.find((runtime) =>
    Boolean(runtime.definition.wecomBotId?.trim() || process.env.WECOM_BOT_ID?.trim())
    && Boolean(runtime.definition.wecomBotSecret?.trim() || process.env.WECOM_BOT_SECRET?.trim())
  );
  const status = configuredRuntime ? statusFor(configuredRuntime) : undefined;
  const connected = status?.connected === true;
  const authenticated = status?.authenticated === true;
  const hasRecent = runtimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "wecom"));
  const installed = packageInstalled(ctx.rootDir);
  return {
    type: "wecom",
    label: "企业微信 / WeCom",
    maturity: "experimental",
    installed,
    installCandidates: [
      { label: "@wecom/aibot-node-sdk", url: "https://www.npmjs.com/package/@wecom/aibot-node-sdk" },
      { label: "企业微信接入说明", path: path.join(ctx.rootDir, "docs", "wecom-integration.md") }
    ],
    endpoints: configuredRuntime ? [{
      label: configuredRuntime.definition.name || configuredRuntime.definition.id,
      url: configuredRuntime.definition.wecomWsUrl || process.env.WECOM_WS_URL || "wss://openws.work.weixin.qq.com",
      healthy: connected && authenticated
    }] : [],
    requirements: [
      { id: "sdk", label: "企业微信智能机器人 SDK", required: true, ok: installed, detail: installed ? "@wecom/aibot-node-sdk 已安装。" : "运行 npm install @wecom/aibot-node-sdk。" },
      { id: "bot-id", label: "Bot ID", required: true, ok: Boolean(configuredRuntime?.definition.wecomBotId || process.env.WECOM_BOT_ID), detail: configuredRuntime?.definition.wecomBotId ? "已在路由配置中填写。" : process.env.WECOM_BOT_ID ? "已从环境变量读取。" : "填写 wecomBotId 或设置 WECOM_BOT_ID。" },
      { id: "secret", label: "Bot Secret", required: true, ok: Boolean(configuredRuntime?.definition.wecomBotSecret || process.env.WECOM_BOT_SECRET), detail: configuredRuntime?.definition.wecomBotSecret ? "已在路由配置中填写。" : process.env.WECOM_BOT_SECRET ? "已从环境变量读取。" : "填写 wecomBotSecret 或设置 WECOM_BOT_SECRET。" },
      { id: "connected", label: "WebSocket 已连接并认证", required: true, ok: connected && authenticated, detail: connected && authenticated ? "企业微信智能机器人长连接已认证。" : String(status?.lastError || status?.message || "启动 route 后查看连接状态。") },
      { id: "recent-message", label: "最近收到企业微信消息", required: false, ok: hasRecent, detail: hasRecent ? "已收到过企业微信消息。" : "尚未收到企业微信消息；请在企业微信群里向智能机器人发消息验证。" }
    ],
    warnings: [
      "企业微信接入使用智能机器人 WebSocket 长连接，不使用通用 Webhook。",
      "企业微信群聊模板变量会尽量对齐 NapCat：groupId、userId、sender、message、messageId。"
    ]
  };
}
