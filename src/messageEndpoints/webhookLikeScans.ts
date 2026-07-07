import fs from "node:fs";
import path from "node:path";
import type { MessageAdapterType } from "../adapters/messageAdapter.js";

type AgentMaturity = "verified" | "experimental" | "stub";

type AdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

export type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

export type MessageAdapterScanResult = {
  type: Exclude<MessageAdapterType, "disabled">;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: AdapterEndpoint[];
  requirements?: AdapterRequirement[];
  warnings?: string[];
};

export type WebhookLikeScanContext<Runtime> = {
  rootDir: string;
  adapterRuntimes: (type: MessageAdapterType) => Runtime[];
  routeCallbackEndpoint: (runtime: Runtime, type: MessageAdapterType) => AdapterEndpoint | null;
  routeHasRecentMessages: (runtime: Runtime, type: MessageAdapterType) => boolean;
  checkHttpEndpoint: (url: string, timeoutMs?: number) => Promise<boolean>;
  fenneNotePlaybackUrl: string;
};

function scanCallbacks<Runtime>(ctx: WebhookLikeScanContext<Runtime>, type: Extract<MessageAdapterType, "fennenote" | "xiaoai" | "rabilink" | "webhook">): {
  runtimes: Runtime[];
  callbacks: AdapterEndpoint[];
  callbackReady: boolean;
} {
  const runtimes = ctx.adapterRuntimes(type);
  const callbacks = runtimes.map((runtime) => ctx.routeCallbackEndpoint(runtime, type)).filter(Boolean) as AdapterEndpoint[];
  const callbackReady = callbacks.some((endpoint) => endpoint.healthy);
  return { runtimes, callbacks, callbackReady };
}

export async function scanFenneNoteEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: fenneRuntimes, callbacks: fenneCallbacks, callbackReady: fenneCallbackReady } = scanCallbacks(ctx, "fennenote");
  const fennePlaybackHealthy = await ctx.checkHttpEndpoint(ctx.fenneNotePlaybackUrl, 1200);
  const fenneRecent = fenneRuntimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "fennenote"));

  return {
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    maturity: "experimental",
    installed: fenneCallbackReady || fennePlaybackHealthy,
    installCandidates: [
      { label: "语音交互工作站接线说明", url: "https://github.com/vb2250158/RabiRoute/blob/main/docs/voice-interaction-workstation.md" },
      { label: "本地说明：docs/voice-interaction-workstation.md", path: path.join(ctx.rootDir, "docs", "voice-interaction-workstation.md") }
    ],
    endpoints: [
      ...fenneCallbacks,
      { label: "FenneNote 播放/回复端", url: ctx.fenneNotePlaybackUrl, healthy: fennePlaybackHealthy }
    ],
    requirements: [
      { id: "callback", label: "RabiRoute FenneNote 回调入口", required: true, ok: fenneCallbackReady, detail: fenneCallbacks[0]?.url || "添加 FenneNote 消息端并重启 route 后生成。" },
      { id: "app", label: "FenneNote 桌面端/语音转写端", required: true, ok: fennePlaybackHealthy || undefined, detail: fennePlaybackHealthy ? "检测到 FenneNote 本地播放/回复端可达。" : "此仓库不内置 FenneNote，需要按你的实际分发渠道安装并运行。" },
      { id: "webhook-config", label: "FenneNote 已配置转写 webhook", required: true, ok: fenneRecent, detail: fenneRecent ? "已收到过 FenneNote 语音转写事件。" : "尚未收到 FenneNote 请求；请把回调地址填到 FenneNote 的转写/事件配置里。" },
      { id: "tts", label: "OumuQ / TTS worker", required: false, ok: undefined, detail: "只做语音输入时可先不配；需要播报回复时再配置。" }
    ],
    warnings: [
      "RabiRoute 只能检测自己的回调入口和可选播放端；FenneNote 是否真正录音/转写，需要 FenneNote 端或最近请求日志确认。",
      "不要把 FenneNote 叫成 Webhook；日志和消息文件会按 FenneNote 独立分组。"
    ]
  };
}

export async function scanXiaoAiEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: xiaoaiRuntimes, callbacks: xiaoaiCallbacks, callbackReady: xiaoaiCallbackReady } = scanCallbacks(ctx, "xiaoai");
  const xiaoaiBridgeDir = path.join(ctx.rootDir, "plugin-adapters", "xiaoai-rabiroute");
  const xiaoaiBridgePackage = path.join(xiaoaiBridgeDir, "package.json");
  const xiaoaiBridgeUrl = process.env.XIAOAI_BRIDGE_URL
    || `http://127.0.0.1:${process.env.XIAOAI_BRIDGE_PORT || "8798"}`;
  const xiaoaiBridgeHealthUrl = `${xiaoaiBridgeUrl.replace(/\/+$/, "")}/health`;
  const xiaoaiBridgeHealthy = await ctx.checkHttpEndpoint(xiaoaiBridgeHealthUrl, 1200);
  const xiaoaiRecent = xiaoaiRuntimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "xiaoai"));
  const xiaoaiLocalConfig = path.join(xiaoaiBridgeDir, "xiaoai-local.config.json");
  const openXiaoAiDir = path.join(xiaoaiBridgeDir, "vendor", "open-xiaoai");

  return {
    type: "xiaoai",
    label: "小米音箱 / 小爱",
    maturity: "experimental",
    installed: fs.existsSync(xiaoaiBridgePackage),
    installCandidates: [
      { label: "RabiRoute 小爱桥接适配器", path: xiaoaiBridgeDir },
      { label: "小爱接入 Runbook", path: path.join(xiaoaiBridgeDir, "RUNBOOK.md") },
      { label: "open-xiaoai 参考项目", url: "https://github.com/idootop/open-xiaoai" },
      { label: "xiaogpt 参考项目", url: "https://github.com/yihong0618/xiaogpt" },
      { label: "小爱音箱接入 RabiRoute 技术路线", url: "https://github.com/vb2250158/RabiRoute/blob/main/docs/xiaoai-integration/xiaoai-rabiroute-intercept-route.md" }
    ],
    endpoints: [
      ...xiaoaiCallbacks,
      { label: "小爱桥服务", url: xiaoaiBridgeHealthUrl, healthy: xiaoaiBridgeHealthy }
    ],
    requirements: [
      { id: "bridge-package", label: "PC 侧小爱桥适配器", required: true, ok: fs.existsSync(xiaoaiBridgePackage), detail: fs.existsSync(xiaoaiBridgePackage) ? xiaoaiBridgeDir : "缺少 plugin-adapters/xiaoai-rabiroute。" },
      { id: "bridge-running", label: "小爱桥服务已启动", required: true, ok: xiaoaiBridgeHealthy, detail: xiaoaiBridgeHealthy ? xiaoaiBridgeHealthUrl : `未访问到 ${xiaoaiBridgeHealthUrl}；在小爱桥目录运行 npm start。` },
      { id: "speaker-client", label: "音箱侧 open-xiaoai / xiaogpt / 自定义桥", required: true, ok: undefined, detail: fs.existsSync(openXiaoAiDir) ? "已发现 vendor/open-xiaoai 参考代码；真机补丁/桥接仍需人工确认。" : "需要能从小爱音箱或桥服务把语音事件转发到 PC 侧。" },
      { id: "local-config", label: "本地小爱配置", required: false, ok: fs.existsSync(xiaoaiLocalConfig), detail: fs.existsSync(xiaoaiLocalConfig) ? xiaoaiLocalConfig : "可从 xiaoai-local.config.example.json 复制生成本地配置。" },
      { id: "callback", label: "RabiRoute 小爱回调入口", required: true, ok: xiaoaiCallbackReady, detail: xiaoaiCallbacks[0]?.url || "添加小米音箱消息端并重启 route 后生成。" },
      { id: "recent-event", label: "最近收到小爱事件", required: true, ok: xiaoaiRecent, detail: xiaoaiRecent ? "已收到过小爱语音转写事件。" : "尚未收到小爱桥转发的事件。" }
    ],
    warnings: [
      "小米音箱不是直接连 RabiRoute：需要 open-xiaoai/xiaogpt/自定义桥这类入口层，把语音文本 POST 到 RabiRoute。",
      "open-xiaoai 路线涉及机型、固件和刷机风险；只在确认型号和备份后操作。"
    ]
  };
}

export async function scanRabiLinkEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: rabiLinkRuntimes, callbacks: rabiLinkCallbacks, callbackReady: rabiLinkCallbackReady } = scanCallbacks(ctx, "rabilink");
  const rabiLinkRecent = rabiLinkRuntimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "rabilink"));

  return {
    type: "rabilink",
    label: "RabiLink / Relay 直连",
    maturity: "experimental",
    installed: rabiLinkCallbackReady,
    endpoints: rabiLinkCallbacks,
    requirements: [
      { id: "callback", label: "RabiRoute RabiLink 本地入口", required: true, ok: rabiLinkCallbackReady, detail: rabiLinkCallbacks[0]?.url || "添加 RabiLink 消息端并重启 route 后生成。" },
      { id: "relay-worker", label: "电脑端 Relay worker 已接入", required: true, ok: rabiLinkRecent, detail: rabiLinkRecent ? "已收到过 RabiLink Relay 事件。" : "尚未收到 RabiLink Relay 任务。" },
      { id: "public-url", label: "公网 HTTPS Relay 地址", required: true, ok: undefined, detail: "Rokid/灵珠插件调用公网 Relay；RabiRoute 电脑端负责从 Relay 领取任务并回填回复。" }
    ],
    warnings: ["RabiLink 现在走电脑端直连 Relay；手机 App 只保留为可选调试入口，不再作为主消息中转。"]
  };
}

export async function scanWebhookEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: webhookRuntimes, callbacks: webhookCallbacks, callbackReady: webhookCallbackReady } = scanCallbacks(ctx, "webhook");

  return {
    type: "webhook",
    label: "通用 Webhook",
    maturity: "experimental",
    installed: webhookCallbackReady,
    endpoints: webhookCallbacks,
    requirements: [
      { id: "callback", label: "RabiRoute 通用回调入口", required: true, ok: webhookCallbackReady, detail: webhookCallbacks[0]?.url || "添加通用 Webhook 消息端并重启 route 后生成。" },
      { id: "sender", label: "外部系统已配置 POST", required: true, ok: webhookRuntimes.some((runtime) => ctx.routeHasRecentMessages(runtime, "webhook")), detail: "RabiRoute 无法自动知道外部系统是否已配置；以最近请求日志为准。" }
    ],
    warnings: ["只有真正不知道来源的外部 POST 才用通用 Webhook；FenneNote、小爱、Home Assistant 等应拆成具体消息端。"]
  };
}
