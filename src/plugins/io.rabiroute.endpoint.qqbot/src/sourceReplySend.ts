import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { MessageEndpointSendVariant, MessageEndpointVariantSendInput, MessageEndpointVariantSendResult } from "@rabiroute/plugin-sdk";
import type { QqBotMessageRecord } from "@rabiroute/host-api/history";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";

const variant: MessageEndpointSendVariant = Object.freeze({
  type: "qqbot.source-reply", contractVersion: 1, description: "回复此 Route 和机器人账号收到的原始 QQ 消息。",
  operation: "sendSourceReplyVariant",
  paramsSchema: { type: "object", additionalProperties: false, required: ["sourceMessageId"],
    properties: { sourceMessageId: { type: "string", pattern: "^qqbot-\\S+$" } } },
  dataSchema: { type: "object", additionalProperties: false, required: ["text"],
    properties: { text: { type: "string", pattern: "\\S" } } },
  readText: data => String(data.text).trim()
});

async function readOriginalSource(directories: readonly string[], gatewayId: string, accountId: string, messageId: string) {
  for (const directory of directories) {
    const stream = createReadStream(path.join(directory, "qqbot-messages.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record: QqBotMessageRecord;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.messageId === messageId && record.adapterType === "qqbot" && record.gatewayId === gatewayId
          && record.instanceId === accountId && record.platformMessageId) return record;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}

export function createBotSourceReply(readRoute: (id: string) => GatewayDefinition | undefined,
  reply: (source: QqBotMessageRecord, text: string) => Promise<{ messageId: string }>) {
  return { variant,
    async sendSourceReplyVariant(input: MessageEndpointVariantSendInput): Promise<MessageEndpointVariantSendResult> {
      const route = readRoute(input.gatewayId);
      const accountId = route?.qqbotAccountId;
      const messageId = input.target.sourceMessageId;
      if (!accountId || typeof messageId !== "string" || !messageId.startsWith("qqbot-")) {
        throw new Error("The original QQ Bot Route or source message is unavailable.");
      }
      const source = await readOriginalSource(input.sourceDataDirs, input.gatewayId, accountId, messageId);
      if (!source || readRoute(input.gatewayId) !== route) throw new Error("The original QQ Bot Route or source message changed.");
      const result = await reply(source, variant.readText(input.data));
      return { ...result, target: { targetType: source.groupId ? "group" : "private", groupId: source.groupId,
        userId: source.userId, instanceId: source.instanceId } };
    }
  };
}
