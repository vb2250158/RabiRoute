import { ReadSettingsError } from "@rabiroute/host-api/shared/readSettingsError";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { QQ_READ_LIMITS, QQ_READ_KINDS, QQ_MESSAGE_ID_PATTERN, QQ_ATTACHMENT_INDEX_PATTERN, QQ_TARGET_ID_PATTERN, QQ_FORWARD_PATH_PATTERN, QQ_FORWARD_NODE_PATTERN,
  QQ_HISTORY_QUERY_SCHEMA, QQ_MESSAGE_QUERY_SCHEMA, QQ_FORWARD_QUERY_SCHEMA, QQ_FORWARD_LIMITS, projectPublicQqMessage, qqReadOperationContract, type QqReadTarget } from "./qqReadContract.js";
import type http from "node:http";
import { createHash } from "node:crypto";
import { normalizeNapCatInstances, definitionUsesNapcat, type GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "@rabiroute/host-api/manager/lanAgentBodyAuthority";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import { QqReadError, qqRead, qqMessageHasId, qqMessageMatches, qqPrivateMessageNeedsHistory, qqMessageMedia, qqMessageText, qqMessageTimestamp, readQqMedia, type QqMessage } from "./qqMessageMedia.js";
import type { QqDirectoryContact, QqGroupMember } from '@rabiroute/host-api/shared/qqConversationHistory';
import {qqPartsPreview,qqStructuredMessageParts} from '@rabiroute/host-api/shared/qqMessageParts';
import { normalizeQqForwardNode, projectQqForwardNode, readQqForward } from "./qqForwardRead.js";

export type QqMessageRoutesContext = {
  local: (request: http.IncomingMessage) => boolean;
  route: (routeId: string) => GatewayDefinition | undefined;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
  transport?: typeof fetch;
};
const activeReads = new WeakMap<QqMessageRoutesContext, number>();

/** One exact current-message read owner for both public QQ reads and outbound quote validation. */
export async function readExactQqMessage(input: {
  endpoint: { httpUrl: string; accessToken: string };
  kind: "group" | "private";
  target: string;
  messageId: string;
  signal: AbortSignal;
  current: () => void;
  transport?: typeof fetch;
}): Promise<QqMessage> {
  const historyPage = async () => {
    input.current();
    const data = await qqRead(input.endpoint, input.kind === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
      [input.kind === "group" ? "group_id" : "user_id"]: input.target,
      count: QQ_READ_LIMITS.fallbackCount,
      message_seq: input.messageId,
      reverseOrder: true,
      disable_get_url: true,
      parse_mult_msg: false
    }, input.signal, input.transport);
    input.current();
    if (!Array.isArray(data.messages)) throw new QqReadError(503, "QQ_HISTORY_INVALID_RESPONSE");
    const found = data.messages.find(item => qqMessageHasId(item, input.messageId));
    if (!found) throw new QqReadError(404, "QQ_MESSAGE_NOT_IN_PAGE");
    if (!qqMessageMatches(found, input.kind, input.target, "history")) throw new QqReadError(409, "QQ_MESSAGE_TARGET_MISMATCH");
    return found;
  };
  input.current();
  try {
    const value = await qqRead(input.endpoint, "get_msg", { message_id: input.messageId }, input.signal, input.transport);
    input.current();
    if (input.kind === "private" && qqPrivateMessageNeedsHistory(value) && qqMessageHasId(value, input.messageId)) return historyPage();
    if (!qqMessageMatches(value, input.kind, input.target) || !qqMessageHasId(value, input.messageId)) {
      throw new QqReadError(409, "QQ_MESSAGE_TARGET_MISMATCH");
    }
    return value;
  } catch (error) {
    if (error instanceof QqReadError && error.code !== "QQ_UPSTREAM_UNAVAILABLE") throw error;
    return historyPage();
  }
}

const messagePath = new RegExp(`^/api/agent/qq/messages/(${QQ_MESSAGE_ID_PATTERN.source.slice(1, -1)})(?:/attachments/(${QQ_ATTACHMENT_INDEX_PATTERN.source.slice(1, -1)}))?$`);
const forwardPath = new RegExp(`^/api/agent/qq/messages/(${QQ_MESSAGE_ID_PATTERN.source.slice(1, -1)})/forwards/(${QQ_FORWARD_PATH_PATTERN.source.slice(1, -1)})(?:/nodes/(${QQ_FORWARD_NODE_PATTERN.source.slice(1, -1)})(?:/attachments/(${QQ_ATTACHMENT_INDEX_PATTERN.source.slice(1, -1)}))?)?$`);

/** The same read owner returns finite DTO/byte results to executable and transitional adapters. */
async function readQqMessageResult(request: http.IncomingMessage, url: URL,
  response: Pick<http.ServerResponse, "once" | "off" | "writableEnded">, context: QqMessageRoutesContext, selected: QqReadTarget | { kind: 'contacts' } | { kind: 'members' }): Promise<ApiOperationResult> {
  const history = selected.kind === "history";
  const headers = { "cache-control": "private, no-store" };
  const fail = (status: number, errorCode: string, message?: string): ApiOperationResult => ({ status, headers, body: { code: -1, errorCode, ...(message ? { message } : {}) } });
  const ok = (data: unknown): ApiOperationResult => ({ status: 200, headers, body: { code: 0, data } });
  if (request.method !== "GET") return fail(405, "QQ_READ_GET_REQUIRED");
  const authorized = () => {
    try {
      const principal = assertTrustedLanAgentPrincipal(request);
      if (hasAuthenticatedConnectionRequest(request) || principal) return true;
      if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"] || request.headers["x-rabiroute-peer-proxy"]) return false;
      return context.local(request) && !getTrustedLanAgentSource(request) && !hasLanAgentBodyGuard(request);
    } catch { return false; }
  };
  if (!authorized()) return fail(403, "QQ_READ_AUTH_REQUIRED");
  const contacts = selected.kind === 'contacts';
  const forwardList = selected.kind === "forward";
  const allowed = contacts ? ['routeId'] : Object.keys(history ? QQ_HISTORY_QUERY_SCHEMA.properties : forwardList ? QQ_FORWARD_QUERY_SCHEMA.properties : QQ_MESSAGE_QUERY_SCHEMA.properties);
  const keys = [...url.searchParams.keys()];
  const routeId = url.searchParams.get("routeId") ?? "";
  const kind = url.searchParams.get("kind") ?? "";
  const target = url.searchParams.get("target") ?? "";
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit") ?? (forwardList ? QQ_FORWARD_LIMITS.pageDefault : QQ_READ_LIMITS.historyDefault));
  const offsetText = url.searchParams.get("offset") ?? "0", offset = Number(offsetText);
  if (keys.some(key => !allowed.includes(key) || !url.searchParams.get(key)) || new Set(keys).size !== keys.length
    || !routeId || routeId.length > QQ_READ_LIMITS.routeIdChars || (!contacts && (!(QQ_READ_KINDS as readonly string[]).includes(kind) || !QQ_TARGET_ID_PATTERN.test(target)))
    || (selected.kind === 'members' && kind !== 'group')
    || (forwardList && (!QQ_FORWARD_NODE_PATTERN.test(offsetText) || !Number.isSafeInteger(offset)))
    || ((selected.kind === "forward" || selected.kind === "forward-node" || selected.kind === "forward-attachment")
      && (!QQ_FORWARD_PATH_PATTERN.test(selected.forwardPath) || selected.forwardPath.split(".").some(value => !Number.isSafeInteger(Number(value)))
        || (selected.kind !== "forward" && (!Number.isSafeInteger(selected.nodeIndex) || selected.nodeIndex < 0))))
    || (cursor !== null && !QQ_MESSAGE_ID_PATTERN.test(cursor)) || !Number.isInteger(limit) || limit < 1 || limit > (forwardList ? QQ_FORWARD_LIMITS.pageMax : QQ_READ_LIMITS.historyMax)
    || request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) return fail(400, "QQ_READ_INVALID_QUERY");
  const definition = context.route(routeId);
  if (!definition || definition.enabled !== true || !definitionUsesNapcat(definition)) return fail(409, "QQ_READ_ROUTE_UNAVAILABLE");
  if (!Array.isArray(definition.napcatInstances) || definition.napcatInstances.length !== 1 || definition.napcatInstances[0]?.enabled === false) return fail(409, "QQ_READ_INSTANCE_AMBIGUOUS");
  const instance = normalizeNapCatInstances(definition)[0]!;
  const endpoint = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" };
  let concurrency: number, timeoutMs: number;
  const mediaRead = selected.kind === "attachment" || selected.kind === "forward-attachment";
  try { concurrency = QQ_READ_LIMITS.concurrency; timeoutMs = mediaRead ? QQ_READ_LIMITS.mediaTimeoutMs : QQ_READ_LIMITS.timeoutMs; }
  catch (error) { if (error instanceof ReadSettingsError) return fail(503, error.code, error.message); throw error; }
  const active = activeReads.get(context) ?? 0;
  if (active >= concurrency) return fail(429, "QQ_READ_BUSY",
    `QQ reads are busy; RABIROUTE_QQ_READ_CONCURRENCY=${QQ_READ_LIMITS.concurrency}. Retry after current reads complete or adjust this Manager environment setting.`);
  activeReads.set(context, active + 1);
  const controller = new AbortController();
  const timeoutSetting = mediaRead ? "RABIROUTE_QQ_MEDIA_TIMEOUT_MS" : "RABIROUTE_QQ_READ_TIMEOUT_MS";
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const closed = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", closed);
  const current = () => {
    const now = normalizeNapCatInstances(definition);
    if (!authorized()) throw new QqReadError(403, "QQ_READ_AUTHORIZATION_REVOKED");
    if (context.route(routeId) !== definition || definition.enabled !== true || !definitionUsesNapcat(definition)
      || definition.napcatInstances?.length !== 1 || now.length !== 1 || now[0]?.enabled === false
      || now[0]?.id !== instance.id || now[0]?.httpUrl !== endpoint.httpUrl || (now[0]?.accessToken ?? "") !== endpoint.accessToken) throw new QqReadError(409, "QQ_READ_ROUTE_CHANGED");
  };
  const page = async (anchor: string | null, count: number) => {
    current();
    const data = await qqRead(endpoint, kind === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
      [kind === "group" ? "group_id" : "user_id"]: target, count,
      ...(anchor ? { message_seq: anchor } : {}), reverseOrder: true, disable_get_url: true, parse_mult_msg: false
    }, controller.signal, context.transport);
    if (!Array.isArray(data.messages)) throw new QqReadError(503, "QQ_HISTORY_INVALID_RESPONSE");
    const rows = data.messages.filter((row): row is QqMessage => qqMessageMatches(row, kind, target, "history"));
    return { rows: rows.slice(0, count), skippedCount: data.messages.length - rows.length };
  };
  const project = (row: QqMessage) => projectPublicQqMessage(row, { routeId, kind: kind as "group" | "private", target });
  try {
    if (selected.kind === 'contacts') {
      current();
      const results = await Promise.allSettled([
        ...(['get_group_list','get_friend_list','get_login_info'] as const).map(action => qqRead(endpoint,action,{},controller.signal,context.transport)),
        qqRead(endpoint,'get_recent_contact',{count:50},controller.signal,context.transport)
      ]);
      current();
      // Keep completed directory sections when an optional read fails. If every
      // upstream read was cancelled, preserve the existing owner's timeout boundary.
      if (controller.signal.aborted && results.every(result => result.status === "rejected")) controller.signal.throwIfAborted();
      const entries: QqDirectoryContact[] = [], warnings: string[] = [];
      for (const [index,result] of results.slice(0,2).entries()) {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) { warnings.push(index ? 'QQ_FRIEND_LIST_UNAVAILABLE' : 'QQ_GROUP_LIST_UNAVAILABLE'); continue; }
        for (const value of result.value) {
          if (!value || typeof value !== 'object') continue;
          const row = value as Record<string,unknown>, target = String(index ? row.user_id ?? '' : row.group_id ?? '');
          if (!QQ_TARGET_ID_PATTERN.test(target)) continue;
          entries.push({kind:index?'private':'group',target,name:String(index ? row.remark || row.nickname || target : row.group_name || target),
            ...(!index && typeof row.member_count==='number' ? {memberCount:row.member_count} : {})});
        }
      }
      const login=results[2],userId=login?.status==='fulfilled'?String(login.value.user_id??''):'';
      const account=QQ_TARGET_ID_PATTERN.test(userId)?{userId,name:String(login?.status==='fulfilled'?login.value.nickname??userId:userId)}:undefined;
      if(!account)warnings.push('QQ_LOGIN_INFO_UNAVAILABLE');
      const recent=results[3];
      if(recent?.status!=='fulfilled'||!Array.isArray(recent.value))warnings.push('QQ_RECENT_CONTACT_UNAVAILABLE');
      if(recent?.status==='fulfilled'&&Array.isArray(recent.value))for(const value of recent.value) {
        if(!value||typeof value!=='object')continue;
        const row=value as Record<string,unknown>,kind=Number(row.chatType)===2?'group':Number(row.chatType)===1?'private':undefined;
        const target=String(row.peerUin??'');if(!kind||!QQ_TARGET_ID_PATTERN.test(target))continue;
        let entry=entries.find(item=>item.kind===kind&&item.target===target);
        if(!entry){entry={kind,target,name:String(row.remark||row.peerName||target)};entries.push(entry);}
        const time=Number(row.msgTime);if(Number.isFinite(time)&&time>0)entry.time=time;
        if(row.lastestMsg&&typeof row.lastestMsg==='object'){
          const message=row.lastestMsg as QqMessage;
          const prefix=kind==='group'?String(row.sendMemberName||row.sendNickName||''):'';
          entry.preview=(prefix?prefix+': ':'')+qqPartsPreview(qqStructuredMessageParts(message.message,qqMessageText(message)));
        }
      }
      return ok({routeId,instanceId:instance.id,entries,warnings,...(account?{account}:{})});
    }
    if (selected.kind === 'members') {
      current();
      const result = await qqRead(endpoint,'get_group_member_list',{group_id:target},controller.signal,context.transport);
      current();
      if (!Array.isArray(result)) throw new QqReadError(503,'QQ_GROUP_MEMBERS_INVALID_RESPONSE');
      const entries: QqGroupMember[] = [];
      for (const value of result) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string,unknown>, id = String(row.user_id ?? '');
        if (!QQ_TARGET_ID_PATTERN.test(id)) continue;
        entries.push({id,name:String(row.card || row.nickname || id),role:String(row.role || 'member')});
      }
      return ok({routeId,instanceId:instance.id,target,entries});
    }
    if (selected.kind === "history") {
      const { rows, skippedCount } = await page(cursor, limit); current();
      const oldest = rows.reduce<QqMessage | undefined>((a, b) => !a || Number(qqMessageTimestamp(b.time)) < Number(qqMessageTimestamp(a.time)) ? b : a, undefined);
      const next = oldest ? String(oldest.message_id) : null;
      return ok({ routeId, instanceId: instance.id, entries: rows.map(project), nextCursor: next === cursor ? null : next,
        cursorStalled: (next !== null && next === cursor) || (rows.length === 0 && skippedCount > 0), completenessUnknown: true,
        ...(skippedCount > 0 ? { skippedCount } : {}) });
    }
    const messageId = selected.messageId;
    const row = await readExactQqMessage({ endpoint, kind: kind as "group" | "private", target, messageId,
      signal: controller.signal, current, transport: context.transport });
    current();
    if (selected.kind === "message") return ok({ routeId, instanceId: instance.id, ...project(row) });
    let attachmentOwner = row;
    if (selected.kind === "forward" || selected.kind === "forward-node" || selected.kind === "forward-attachment") {
      const bundle = await readQqForward({ root: row, forwardPath: selected.forwardPath, endpoint, signal: controller.signal, current, transport: context.transport });
      current();
      const selection = { routeId, kind: kind as "group" | "private", target };
      if (selected.kind === "forward") {
        const rawPage = bundle.nodes.slice(offset, offset + limit);
        const entries = rawPage.flatMap((value, index) => {
          const node = normalizeQqForwardNode(value);
          return node ? [projectQqForwardNode(node, selection, messageId, selected.forwardPath, offset + index)] : [];
        });
        const skippedCount = rawPage.length - entries.length;
        const next = offset + rawPage.length;
        return ok({ routeId, instanceId: instance.id, messageId, forwardPath: selected.forwardPath, entries,
          total: bundle.total, offset, nextOffset: next < bundle.total ? next : null,
          truncated: skippedCount > 0, ...(skippedCount ? { skippedCount } : {}) });
      }
      const node = normalizeQqForwardNode(bundle.nodes[selected.nodeIndex]);
      if (!node) throw new QqReadError(404, "QQ_FORWARD_NODE_NOT_FOUND");
      if (selected.kind === "forward-node") return ok({ routeId, instanceId: instance.id, ...projectQqForwardNode(node, selection, messageId, selected.forwardPath, selected.nodeIndex) });
      attachmentOwner = node;
    }
    const attachment = qqMessageMedia(attachmentOwner.message ?? attachmentOwner.raw_message)[selected.index];
    if (!attachment) throw new QqReadError(404, "QQ_ATTACHMENT_NOT_FOUND");
    const transport = selected.kind === "forward-attachment" ? async (...args: Parameters<typeof fetch>) => {
      controller.signal.throwIfAborted(); current();
      const result = await (context.transport ?? fetch)(...args);
      current(); controller.signal.throwIfAborted();
      return result;
    } : context.transport;
    const body = await readQqMedia(endpoint, attachment, controller.signal, transport);
    if (selected.kind === "forward-attachment") controller.signal.throwIfAborted();
    current();
    return { status: 200, body, headers: { ...headers, "content-length": String(body.length),
      "x-rabiroute-content-sha256": createHash("sha256").update(body).digest("hex"), "x-content-type-options": "nosniff",
      "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}` } };
  } catch (error) {
    if (error instanceof ReadSettingsError) return fail(503, error.code, error.message);
    if (timedOut) return fail(503, "QQ_READ_TIMEOUT", `QQ read exceeded ${timeoutSetting}=${timeoutMs} ms. Adjust this Manager environment setting if the source needs longer.`);
    return fail(error instanceof QqReadError ? error.status : 503, error instanceof QqReadError ? error.code : "QQ_UPSTREAM_UNAVAILABLE",
      error instanceof QqReadError && error.message !== error.code ? error.message : error instanceof RangeError ? `QQ media exceeds the current runtime's buffer or memory capacity (${error.name}).` : undefined);
  }
  finally { activeReads.set(context, (activeReads.get(context) ?? 1) - 1); clearTimeout(timeout); response.off("close", closed); }
}

export function createQqMessageOperations(context: QqMessageRoutesContext): readonly ApiOperationDefinition[] {
  const messages: ApiOperationDefinition[] = (["history", "message", "attachment"] as const).map(kind => ({ contract: qqReadOperationContract(kind), handler: input => {
    const selected: QqReadTarget = kind === "history" ? { kind } : kind === "message" ? { kind, messageId: input.path.messageId! }
      : { kind, messageId: input.path.messageId!, index: Number(input.path.attachmentIndex) };
    return readQqMessageResult(input.request, input.url, input.response, context, selected);
  } }));
  for (const kind of ["forward", "forward-node", "forward-attachment"] as const) {
    messages.push({ contract: qqReadOperationContract(kind), handler: input => readQqMessageResult(input.request, input.url, input.response, context,
      { kind, messageId: input.path.messageId!, forwardPath: input.path.forwardPath!,
        ...(kind !== "forward" ? { nodeIndex: Number(input.path.nodeIndex) } : {}),
        ...(kind === "forward-attachment" ? { index: Number(input.path.attachmentIndex) } : {}) } as QqReadTarget) });
  }
  for (const kind of ['contacts','members'] as const) {
    const base = qqReadOperationContract('history');
    const pathTemplate = `/api/agent/qq/${kind==='members'?'group-members':'contacts'}`;
    const contract: ApiOperationContract = {...base,operationId:`agent.qq.${kind}.read`,pathTemplate,aliases:[`agent:GET:${pathTemplate}`],
      description:kind==='members' ? 'Read members of the exact selected QQ group; private chats never use this operation.' : 'Read safe group/friend display names for the exact selected QQ account.',
      request:{...base.request,query:kind==='contacts'
        ? {type:'object',required:['routeId'],additionalProperties:false,properties:{routeId:{type:'string',minLength:1,maxLength:QQ_READ_LIMITS.routeIdChars}}}
        : {...QQ_MESSAGE_QUERY_SCHEMA,properties:{...QQ_MESSAGE_QUERY_SCHEMA.properties,kind:{const:'group'}}}},
      responses:{...base.responses,'200':{mediaType:'application/json',schema:{type:'object',required:['code','data'],properties:{code:{const:0},data:{type:'object',required:['routeId','instanceId','entries'],properties:{routeId:{type:'string'},instanceId:{type:'string'},entries:{type:'array',items:{type:'object'}},warnings:{type:'array',items:{type:'string'}},account:{type:'object',required:['userId','name'],additionalProperties:false,properties:{userId:{type:'string',pattern:QQ_TARGET_ID_PATTERN.source},name:{type:'string'}}}}}}}}}
    };
    messages.push({contract,handler:input=>readQqMessageResult(input.request,input.url,input.response,context,{kind})});
  }
  return messages;
}

/** Transitional raw adapter; production registration uses the executable operations above. */
export function handleQqMessageRoutes(request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  context: QqMessageRoutesContext, track: <T>(operation: Promise<T>) => Promise<T>): boolean {
  const match = messagePath.exec(url.pathname);
  const forward = forwardPath.exec(url.pathname);
  const selected: QqReadTarget | undefined = url.pathname === "/api/agent/qq/history" ? { kind: "history" }
    : match ? match[2] === undefined ? { kind: "message", messageId: match[1]! }
      : { kind: "attachment", messageId: match[1]!, index: Number(match[2]) }
    : forward ? forward[3] === undefined ? { kind: "forward", messageId: forward[1]!, forwardPath: forward[2]! }
      : forward[4] === undefined ? { kind: "forward-node", messageId: forward[1]!, forwardPath: forward[2]!, nodeIndex: Number(forward[3]) }
        : { kind: "forward-attachment", messageId: forward[1]!, forwardPath: forward[2]!, nodeIndex: Number(forward[3]), index: Number(forward[4]) } : undefined;
  if (!selected) return false;
  void track(readQqMessageResult(request, url, response, context, selected).then(result => {
    if (response.destroyed || response.writableEnded) return;
    for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, value);
    if (result.body instanceof Uint8Array) { response.writeHead(result.status); response.end(result.body); }
    else context.json(response, result.status, result.body);
  })).catch(() => { if (!response.destroyed) response.destroy(); });
  return true;
}
