import { config } from "./config.js";
import { searchMessages, todayMessages, type GroupMessageRecord } from "./history.js";

export function stripMention(raw: string): string {
  return raw.replace(/\[CQ:at,qq=\d+\]/g, "").trim();
}

export function buildReply(record: GroupMessageRecord): string | null {
  const content = stripMention(record.rawMessage);

  if (content === "/ping" || content === "ping") {
    return `${config.botNickname} 在线`;
  }

  if (content.startsWith("/echo ")) {
    return content.slice("/echo ".length).trim() || "收到";
  }

  if (content.startsWith("/查 ")) {
    const keyword = content.slice("/查 ".length).trim();
    const results = searchMessages(keyword);
    if (results.length === 0) {
      return `没找到和「${keyword}」相关的已记录消息。`;
    }

    return [
      `找到 ${results.length} 条最近记录：`,
      ...results.map((item) => {
        const time = new Date(item.time * 1000).toLocaleString("zh-CN", { hour12: false });
        const sender = item.senderName || String(item.userId);
        return `${time} ${sender}: ${stripMention(item.rawMessage).slice(0, 120)}`;
      })
    ].join("\n");
  }

  if (content === "/总结今天") {
    const messages = todayMessages(record.groupId);
    if (messages.length === 0) {
      return "今天还没有记录到这个群的消息。";
    }

    const top = messages.slice(-20).map((item) => stripMention(item.rawMessage)).filter(Boolean);
    return [
      `今天已记录 ${messages.length} 条消息。最近讨论片段：`,
      ...top.map((line, index) => `${index + 1}. ${line.slice(0, 80)}`)
    ].join("\n");
  }

  if (content.startsWith(`@${config.botNickname}`)) {
    return "我在听～有什么可以帮你的？也可以试试 /查 关键词、/总结今天、/ping。";
  }

  return null;
}
