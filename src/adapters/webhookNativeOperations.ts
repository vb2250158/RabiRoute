import type { ApiHttpProxyDefinition, ApiOperationContract } from "../manager/apiOperationContract.js";
import type { ApiExternalListenerDefinition } from "../manager/apiExternalListenerBinding.js";
import type { WebhookAdapterProfile } from "./webhookAdapter.js";
import type { createWebhookHttpOwner, createWebhookRequestProducer, WebhookHttpReply } from "./webhookHttpOwner.js";

export function webhookListenerBinding(profile: WebhookAdapterProfile, port: number, listenerId: string): ApiExternalListenerDefinition {
  const bindHost = profile.host || "127.0.0.1";
  const hostname = ["0.0.0.0", "::", "[::]"].includes(bindHost) ? undefined
    : new URL(`http://${bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost}`).hostname;
  return { listenerId, address: { protocol: "http", port, ...(hostname ? { hostname } : {}) },
    protocol: "rabi-webhook-json", invocation: "native", authentication: { kind: "none",
      description: "Original public Rabi webhook listener admission; no additional token or signature. Manager and node bearer credentials are not sent to this listener." } };
}

/** Seven concrete public operations across the three profiles; the internal fallback only preserves native 404 rejection. */
export function createWebhookNativeOperations(context: {
  profile: WebhookAdapterProfile; webhookPath: string; replies: boolean;
  owner: ReturnType<typeof createWebhookHttpOwner>;
  producer: ReturnType<typeof createWebhookRequestProducer>;
  operationId(name: string): string;
}): readonly ApiHttpProxyDefinition[] {
  const { owner, producer } = context;
  const definitions: ApiHttpProxyDefinition[] = [];
  const add = (name: string, method: ApiOperationContract["method"], pathTemplate: string,
    execute: (input: Parameters<ApiHttpProxyDefinition["handler"]>[0]) => WebhookHttpReply | Promise<WebhookHttpReply>, rejected = false) => {
    definitions.push({ contract: {
      operationId: context.operationId(name), contractVersion: "1.0.0", method, pathTemplate,
      exposure: rejected ? "internal" : "public", transport: "http",
      description: rejected ? "Original native 404 rejection only. No business dispatch or capability is hidden in this compatibility fallback."
        : `${context.profile.label} native ${name}: exact method and pathname; original codec, response and source ownership.`,
      request: { path: rejected ? { type: "object", required: ["nativePath"], properties: { nativePath: { type: "string" } }, additionalProperties: false }
        : { type: "object", additionalProperties: false }, ...(rejected ? { pathRemainder: "nativePath" } : {}),
        query: true, headers: true, body: { kind: "passthrough" } },
      httpProxy: { wire: { dataFrameBytes: 1024 * 1024, streamWindowBytes: 1024 * 1024, maxConcurrentStreams: Number.MAX_SAFE_INTEGER },
        completion: "The original native owner parses, accepts and writes its response; retirement joins the actual callback and socket close.",
        cancellation: "Stop the original listener, destroy incomplete uploads and wait for accepted callbacks. Never replay a message." },
      responses: { default: { mediaType: "*/*", passthrough: true } },
      effects: { mode: rejected ? "native-rejection" : method === "GET" ? "native-read" : "native-message-ingress",
        description: rejected ? "Return the original empty 404 and original rejection diagnostic; never call a message or replies business owner."
          : "Original acceptWebhookPayload, acceptedResponse and localRabiLinkReplies own records, trusted source flags, record-first behavior and routing." },
      recovery: { strategy: method === "GET" ? "repeat-native-read" : "inspect-original-message",
        description: "Retain the original message ID and reply cursor. No retry, new identity, duplicate forwarding or local fallback is introduced." },
      validators: [{ id: "webhook.native-wire", description: "Exact native path including trailing/double slash; unknown queries and GET bodies ignored; arbitrary Content-Type; empty POST becomes {}; replacement UTF-8; raw 1 MiB cap destroys the request; original parsing/business failures return 500 text." }]
    }, handler: input => producer.track(async () => {
      input.assertCurrent();
      const reply = producer.accepting() ? await execute(input) : owner.stopping();
      if (input.response.destroyed || input.response.writableEnded) return;
      input.assertCurrent(); input.prepareResponse(reply.statusCode, reply.headers ?? {});
      input.response.writeHead(reply.statusCode, reply.headers).end(reply.body);
    }) });
  };
  add("ready", "GET", context.webhookPath, () => owner.ready());
  add("message", "POST", context.webhookPath, input => owner.message(input.request));
  if (context.replies) add("replies", "GET", `${context.webhookPath}/replies`, input => owner.replies(input.url));
  add("rejected", "*", "/:nativePath", input => owner.rejected(input.request), true);
  return definitions;
}
