import { QqReadError, qqRead, qqMessageTimestamp, type QqMessage } from "./qqMessageMedia.js";
import { projectPublicQqMessage, QQ_FORWARD_PATH_PATTERN, type QqReadSelection } from "./qqReadContract.js";

const scalar = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const decode = (value: string): string => value.replaceAll("&#44;", ",").replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&amp;", "&");

/** Preserve occurrence positions, including invalid references; display parts use the same forward order. */
function forwardReference(message: QqMessage, index: number): string {
  const content = message.message ?? message.raw_message;
  const references: Array<Record<string, unknown> | undefined> = Array.isArray(content)
    ? content.filter(segment => object(segment)?.type === "forward").map(segment => object(object(segment)?.data))
    : typeof content === "string" ? [...content.matchAll(/\[CQ:forward((?:,[^\]]*)?)\]/g)].map(match => Object.fromEntries(match[1]!.split(",").slice(1).map(field => {
      const at = field.indexOf("="); return at < 0 ? [field, ""] : [field.slice(0, at), decode(field.slice(at + 1))];
    }))) : [];
  const data = references[index];
  if (!data) throw new QqReadError(404, "QQ_FORWARD_NOT_FOUND");
  const id = scalar(data.id ?? data.message_id ?? data.resid);
  if (!id) throw new QqReadError(422, "QQ_FORWARD_REFERENCE_UNAVAILABLE");
  return id;
}

/** Forward nodes are attributed only to their own provider fields, never to the enclosing group or sender. */
export function normalizeQqForwardNode(value: unknown): QqMessage | undefined {
  let row = object(value);
  if (row?.type === "node") row = object(row.data);
  if (!row) return;
  const message = row.message ?? row.content ?? row.raw_message;
  if (!Array.isArray(message) && typeof message !== "string") return;
  const sender = object(row.sender);
  return { message_id: scalar(row.message_id), message_type: "", message,
    ...(typeof row.raw_message === "string" ? { raw_message: row.raw_message } : {}),
    time: qqMessageTimestamp(row.time),
    sender: { user_id: scalar(sender?.user_id ?? row.user_id ?? row.uin),
      nickname: scalar(sender?.nickname ?? row.nickname ?? row.name), card: scalar(sender?.card) } };
}

/** Resolve only IDs reached from the freshly authorized root, under the caller's existing read lease. */
export async function readQqForward(input: {
  root: QqMessage; forwardPath: string; endpoint: { httpUrl: string; accessToken: string };
  signal: AbortSignal; current(): void; transport?: typeof fetch;
}): Promise<{ nodes: unknown[]; total: number }> {
  if (!QQ_FORWARD_PATH_PATTERN.test(input.forwardPath)) throw new QqReadError(400, "QQ_FORWARD_INVALID_PATH");
  const path = input.forwardPath.split(".").map(Number);
  if (path.some(index => !Number.isSafeInteger(index))) throw new QqReadError(400, "QQ_FORWARD_INVALID_PATH");
  let owner = input.root;
  for (let at = 0; at < path.length; at += 2) {
    input.signal.throwIfAborted(); input.current();
    const id = forwardReference(owner, path[at]!);
    const result = await qqRead(input.endpoint, "get_forward_msg", { message_id: id }, input.signal, input.transport);
    input.current(); input.signal.throwIfAborted();
    if (!Array.isArray(result.messages)) throw new QqReadError(503, "QQ_FORWARD_INVALID_RESPONSE");
    if (!result.messages.length) throw new QqReadError(404, "QQ_FORWARD_EMPTY");
    const nodes = result.messages;
    if (at + 1 === path.length) return { nodes, total: nodes.length };
    const node = normalizeQqForwardNode(nodes[path[at + 1]!]);
    if (!node) throw new QqReadError(404, "QQ_FORWARD_NODE_NOT_FOUND");
    owner = node;
  }
  throw new QqReadError(400, "QQ_FORWARD_INVALID_PATH");
}

export function projectQqForwardNode(row: QqMessage, selection: QqReadSelection, rootMessageId: string, forwardPath: string, nodeIndex: number): Record<string, unknown> {
  const projected = projectPublicQqMessage(row, selection);
  const attachments = projected.attachments as Array<Record<string, unknown>>;
  return { ...projected, nodeIndex, attachments: attachments.map(attachment => ({ ...attachment,
    contentUrl: `/api/agent/qq/messages/${encodeURIComponent(rootMessageId)}/forwards/${forwardPath}/nodes/${nodeIndex}/attachments/${attachment.index}?${new URLSearchParams(selection)}` })) };
}
