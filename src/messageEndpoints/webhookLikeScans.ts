import type { GatewayMessageAdapterType, MessageEndpointType } from "../adapters/messageAdapter.js";

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
  type: MessageEndpointType;
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
  adapterRuntimes: (type: MessageEndpointType) => Runtime[];
  routeCallbackEndpoint: (runtime: Runtime, type: MessageEndpointType) => AdapterEndpoint | null;
  routeHasRecentMessages: (runtime: Runtime, type: MessageEndpointType) => boolean | undefined;
  checkHttpEndpoint: (url: string, timeoutMs?: number) => Promise<boolean>;
};

export function recentMessageEvidence<Runtime>(
  runtimes: readonly Runtime[],
  read: (runtime: Runtime) => boolean | undefined
): boolean | undefined {
  const results = runtimes.map(read);
  return results.includes(true) ? true : results.includes(undefined) ? undefined : false;
}

function scanCallbacks<Runtime>(ctx: WebhookLikeScanContext<Runtime>, type: Extract<GatewayMessageAdapterType, "rabilink" | "webhook">): {
  runtimes: Runtime[];
  callbacks: AdapterEndpoint[];
  callbackReady: boolean;
} {
  const runtimes = ctx.adapterRuntimes(type);
  const callbacks = runtimes.map((runtime) => ctx.routeCallbackEndpoint(runtime, type)).filter(Boolean) as AdapterEndpoint[];
  const callbackReady = callbacks.some((endpoint) => endpoint.healthy);
  return { runtimes, callbacks, callbackReady };
}

export async function scanRabiLinkEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const { runtimes: rabiLinkRuntimes, callbacks: rabiLinkCallbacks, callbackReady: rabiLinkCallbackReady } = scanCallbacks(ctx, "rabilink");
  const rabiLinkRecent = recentMessageEvidence(rabiLinkRuntimes, (runtime) => ctx.routeHasRecentMessages(runtime, "rabilink"));

  return {
    type: "rabilink",
    label: "RabiLink / Relay 直连",
    maturity: "experimental",
    installed: rabiLinkCallbackReady,
    endpoints: rabiLinkCallbacks,
    requirements: [
      { id: "callback", label: "RabiRoute RabiLink 本地入口", required: true, ok: rabiLinkCallbackReady, detail: rabiLinkCallbacks[0]?.url || "添加 RabiLink 消息端并重启 route 后生成。" },
      { id: "relay-worker", label: "电脑端 Relay worker 已接入", required: true, ok: rabiLinkRecent, detail: rabiLinkRecent === undefined ? "历史消息尚未确认，请稍后刷新。" : rabiLinkRecent ? "已收到过 RabiLink Relay 事件。" : "尚未收到 RabiLink Relay 任务。" },
      { id: "public-url", label: "公网 HTTPS Relay 地址", required: true, ok: undefined, detail: "Rokid/灵珠插件调用公网 Relay；RabiRoute 电脑端负责从 Relay 领取任务并回填回复。" }
    ],
    warnings: ["RabiLink 现在走电脑端直连 Relay；手机 App 只保留为可选调试入口，不再作为主消息中转。"]
  };
}

export async function scanWearableEndpoint<Runtime>(ctx: WebhookLikeScanContext<Runtime>): Promise<MessageAdapterScanResult> {
  const runtimes = ctx.adapterRuntimes("wearable");
  const relayRuntimes = ctx.adapterRuntimes("rabilink");
  const recent = recentMessageEvidence(runtimes, (runtime) => ctx.routeHasRecentMessages(runtime, "wearable"));
  return {
    type: "wearable",
    label: "智能手表/手环",
    maturity: "experimental",
    installed: runtimes.length > 0,
    requirements: [
      { id: "route", label: "智能手表/手环消息端", required: true, ok: runtimes.length > 0, detail: runtimes.length > 0 ? "当前 Route 已添加健康消息端。" : "请先在当前 Route 添加智能手表/手环消息端。" },
      { id: "relay", label: "RabiLink Relay 转接", required: true, ok: relayRuntimes.length > 0 || runtimes.length > 0, detail: "健康消息端复用全局 RabiLink Relay 与所选 Rabi PC。" },
      { id: "mobile", label: "RabiLink 手机健康采集", required: true, ok: recent || undefined, detail: recent === undefined ? "历史消息尚未确认，请稍后刷新。" : recent ? "已收到过穿戴健康事件。" : "请在 RabiLink 手机端配置设备、Health Connect 与同步规则。" }
    ],
    warnings: [
      "小米 auth key 只能保存在手机 Android Keystore；不要填进 Route、Relay 或公开配置。",
      "Health Connect 是否有数据取决于厂商写入；小米健康当前真机可能仍为空。"
    ]
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
      { id: "sender", label: "外部系统已配置 POST", required: true, ok: recentMessageEvidence(webhookRuntimes, (runtime) => ctx.routeHasRecentMessages(runtime, "webhook")), detail: "RabiRoute 无法自动知道外部系统是否已配置；以最近请求日志为准。" }
    ],
    warnings: ["只有真正不知道来源的外部 POST 才用通用 Webhook；小爱、Home Assistant 等应拆成具体消息端。"]
  };
}
