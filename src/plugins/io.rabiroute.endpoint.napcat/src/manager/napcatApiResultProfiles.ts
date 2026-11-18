import type { ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { NapcatApiError } from "./napcatApiTransport.js";

type RecordValue = Record<string, unknown>;
type ResultProfile = Readonly<{
  view: "metadata" | "diagnostic" | "credential-summary";
  evidence: "installed-handler" | "installed-example";
  description: string;
  schema: ApiSchema;
  project(value: unknown, parameters: RecordValue): unknown;
}>;
const text = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const scalarId = { anyOf: [text, number] };
const object = (properties: RecordValue, required: readonly string[] = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const array = (items: ApiSchema) => ({ type: "array", items });

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_MISMATCH");
  return value as RecordValue;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_MISMATCH");
  return value;
}
function pick(value: unknown, names: readonly string[]): RecordValue {
  const source = record(value);
  return Object.fromEntries(names.filter(name => Object.hasOwn(source, name)).map(name => [name, source[name]]));
}
function present(value: unknown): boolean { return typeof value === "string" && value.length > 0; }
function numeric(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || value === "" || !Number.isFinite(Number(value))) {
    throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_MISMATCH");
  }
  return Number(value);
}

const honorPerson = object({ user_id: scalarId, nickname: text, description: text }, []);
const honorLists = ["talkative_list", "performer_list", "legend_list", "emotion_list", "strong_newbie_list"];
const doubtFields = ["uin", "nick", "source", "reason", "msg", "group_code", "time", "type"];
const collectionFields = ["cid", "type", "status", "bid", "category", "createTime", "collectTime", "modifyTime", "sequence", "customGroupId", "securityBeat"];
const collectionAuthorFields = ["type", "numId", "strId", "groupId", "groupName", "uid"];
const groupExtMask = ["bindGuildId", "blacklistExpireTime", "companyId", "essentialMsgPrivilege", "essentialMsgSwitch", "fullGroupExpansionSeq",
  "fullGroupExpansionSwitch", "gangUpId", "groupAioBindGuildId", "groupBindGuildIds", "groupBindGuildSwitch", "groupExcludeGuildIds", "groupExtFlameData",
  "groupFlagPro1", "groupInfoExtSeq", "groupOwnerId", "groupSquareSwitch", "hasGroupCustomPortrait", "inviteRobotMemberExamine", "inviteRobotMemberSwitch",
  "inviteRobotSwitch", "isLimitGroupRtc", "lightCharNum", "luckyWord", "luckyWordId", "msgEventSeq", "qqMusicMedalSwitch", "reserve", "showPlayTogetherSwitch",
  "starId", "todoSeq", "viewedMsgDisappearTime"];

const cookieSummarySchema = object({ scope: text, cookiesPresent: boolean, csrfPresent: boolean });
const rkeySummarySchema = array(object({ type: { enum: ["private", "group", "unknown"] }, created_at: number, ttl: number, available: boolean }));
const rkeySummary = (value: unknown, native: boolean) => rows(value).map(item => {
  const row = record(item);
  if (typeof row.rkey !== "string") throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_MISMATCH");
  return { type: native ? row.type === 10 ? "private" : row.type === 20 ? "group" : "unknown" : row.type,
    created_at: numeric(native ? row.time : row.created_at), ttl: numeric(row.ttl), available: present(row.rkey) };
});

const profiles: Readonly<Record<string, ResultProfile>> = {
  get_doubt_friends_add_request: {
    view: "metadata", evidence: "installed-handler", description: "Handler-mapped request metadata; the native acceptance flag stays private.",
    schema: array(object({ uin: scalarId, nick: text, source: text, reason: text, msg: text, group_code: scalarId, time: scalarId, type: { const: "doubt" } }, ["uin", "type"])),
    project: value => rows(value).map(row => pick(row, doubtFields))
  },
  get_group_honor_info: {
    view: "metadata", evidence: "installed-handler", description: "Handler-mapped honor identities and descriptions, with native avatar URLs omitted.",
    schema: object({ group_id: number, current_talkative: honorPerson, ...Object.fromEntries(honorLists.map(name => [name, array(honorPerson)])) }),
    project(value) {
      const source = record(value);
      return { group_id: source.group_id, current_talkative: pick(source.current_talkative, ["user_id", "nickname", "description"]),
        ...Object.fromEntries(honorLists.map(name => [name, rows(source[name]).map(row => pick(row, ["user_id", "nickname", "description"]))])) };
    }
  },
  get_mini_app_ark: {
    view: "metadata", evidence: "installed-handler", description: "Normalized raw/non-raw Ark app metadata. Native config, meta and share payload are outside this view.",
    schema: object({ app: text, view: text, ver: scalarId, prompt: text }, ["app", "view"]),
    project(value) {
      const source = record(record(value).data);
      return { ...pick(source, ["ver", "prompt"]), app: source.app ?? source.appName, view: source.view ?? source.appView };
    }
  },
  get_collection_list: {
    view: "metadata", evidence: "installed-example", description: "Strict installed-example collection metadata profile. Changed native shapes fail validation; media, URLs and rich content are outside this view.",
    schema: object({ errCode: number, collectionSearchList: object({ hasMore: boolean, bottomTimeStamp: text,
      collectionItemList: array(object({ cid: text, type: number, status: number, bid: number, category: number, createTime: text,
        collectTime: text, modifyTime: text, sequence: text, customGroupId: number, securityBeat: boolean,
        author: object({ type: number, numId: text, strId: text, groupId: text, groupName: text, uid: text }, []) }, ["cid"])) }) }),
    project(value) {
      const source = record(value), search = record(source.collectionSearchList);
      return { errCode: source.errCode, collectionSearchList: { ...pick(search, ["hasMore", "bottomTimeStamp"]),
        collectionItemList: rows(search.collectionItemList).map(item => ({ ...pick(item, collectionFields),
          ...(record(item).author !== undefined ? { author: pick(record(item).author, collectionAuthorFields) } : {}) })) } };
    }
  },
  get_qun_album_list: {
    view: "metadata", evidence: "installed-example", description: "Strict installed-example album metadata and original continuation. Native cover URLs are outside this view.",
    schema: object({ attach_info: text, has_more: boolean, album_list: array(object({ album_id: text, album_name: text, create_time: number })) }),
    project: value => ({ ...pick(value, ["attach_info", "has_more"]), album_list: rows(record(value).album_list).map(row => pick(row, ["album_id", "album_name", "create_time"])) })
  },
  get_group_album_media_list: {
    view: "metadata", evidence: "installed-example", description: "Strict installed-example media identity profile; native media URLs need their original resource owner.",
    schema: object({ media_list: array(object({ media_id: text })) }),
    project: value => ({ media_list: rows(record(value).media_list).map(row => pick(row, ["media_id"])) })
  },
  get_robot_uin_range: {
    view: "metadata", evidence: "installed-example", description: "Strict installed-example robot range strings. Native identifiers retain their original precision.",
    schema: array(object({ minUin: { type: "string", pattern: "^[0-9]+$" }, maxUin: { type: "string", pattern: "^[0-9]+$" } })),
    project: value => rows(value).map(row => pick(row, ["minUin", "maxUin"]))
  },
  get_group_shut_list: {
    view: "metadata", evidence: "installed-example", description: "Strict installed-example shut-list profile. The native callback schema is not guaranteed by this example; other shapes fail validation.",
    schema: array(object({ user_id: number, nickname: text, shut_up_time: number })),
    project: value => rows(value).map(row => pick(row, ["user_id", "nickname", "shut_up_time"]))
  },
  get_fileset_info: {
    view: "diagnostic", evidence: "installed-handler", description: "Native helper result flag only. The full file-set schema remains unavailable from the installed mapper and conflicting example.",
    schema: object({ result: number }), project: value => pick(value, ["result"])
  },
  get_flash_file_list: {
    view: "diagnostic", evidence: "installed-handler", description: "Native rsp.result flag only. This diagnostic does not expose a file listing or native error text.",
    schema: object({ result: number }), project: value => pick(value, ["result"])
  },
  get_group_info_ex: {
    view: "diagnostic", evidence: "installed-handler", description: "Presence and field counts only. Requested mask names do not establish native value types.",
    schema: object({ available: boolean, fieldCount: { type: "integer", minimum: 0 }, requestedFieldCount: { type: "integer", minimum: 0 } }),
    project(value) {
      if (value === null) return { available: false, fieldCount: 0, requestedFieldCount: 0 };
      const source = record(value);
      return { available: true, fieldCount: Object.keys(source).length, requestedFieldCount: groupExtMask.filter(name => Object.hasOwn(source, name)).length };
    }
  },
  get_online_file_msg: {
    view: "diagnostic", evidence: "installed-handler", description: "Native container kind/count only. Native message and transfer row contracts remain unestablished.",
    schema: object({ kind: { enum: ["array", "object"] }, itemCount: { type: "integer", minimum: 0 } }),
    project: value => Array.isArray(value) ? { kind: "array", itemCount: value.length } : { kind: "object", itemCount: Object.keys(record(value)).length }
  },
  get_cookies: {
    view: "credential-summary", evidence: "installed-handler", description: "Credential presence and requested domain scope only. Native cookie and CSRF material stays in current request memory.",
    schema: cookieSummarySchema,
    project: (value, params) => ({ scope: params.domain, cookiesPresent: present(record(value).cookies), csrfPresent: present(record(value).bkn) })
  },
  get_credentials: {
    view: "credential-summary", evidence: "installed-handler", description: "Credential presence and requested domain scope only; the native token and cookies are not persisted.",
    schema: cookieSummarySchema,
    project: (value, params) => ({ scope: params.domain, cookiesPresent: present(record(value).cookies), csrfPresent: Number.isFinite(record(value).token) })
  },
  get_csrf_token: {
    view: "credential-summary", evidence: "installed-handler", description: "CSRF material presence only for the exact configured QQ account.",
    schema: object({ type: { const: "csrf" }, available: boolean }),
    project: value => ({ type: "csrf", available: Number.isFinite(record(value).token) })
  },
  get_clientkey: {
    view: "credential-summary", evidence: "installed-handler", description: "Client-key presence only for the exact configured QQ account.",
    schema: object({ type: { const: "clientkey" }, available: boolean }),
    project: value => ({ type: "clientkey", available: present(record(value).clientkey) })
  },
  nc_get_rkey: {
    view: "credential-summary", evidence: "installed-handler", description: "Rkey availability, scope type, creation and TTL only from the native FetchRkey list.",
    schema: rkeySummarySchema, project: value => rkeySummary(value, true)
  },
  get_rkey: {
    view: "credential-summary", evidence: "installed-handler", description: "Rkey availability, scope type, creation and TTL only. This view does not expose native rkeys.",
    schema: rkeySummarySchema, project: value => rkeySummary(value, false)
  },
  get_rkey_server: {
    view: "credential-summary", evidence: "installed-handler", description: "Private/group rkey presence and native expiry only; no persistent secret store or handle is created.",
    schema: object({ privatePresent: boolean, groupPresent: boolean, expired_time: number }, ["privatePresent", "groupPresent"]),
    project: value => ({ privatePresent: present(record(value).private_rkey), groupPresent: present(record(value).group_rkey), ...pick(value, ["expired_time"]) })
  }
};

export function napcatApiResultProfile(action: string) {
  const profile = profiles[action];
  if (!profile) return;
  return { description: profile.description, view: profile.view, evidence: profile.evidence,
    schema: object({ view: { const: profile.view }, evidence: { const: profile.evidence }, data: profile.schema }) };
}

export function projectNapcatApiResultProfile(action: string, value: unknown, parameters: RecordValue): unknown {
  const profile = profiles[action];
  if (!profile) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
  return { view: profile.view, evidence: profile.evidence, data: profile.project(value, parameters) };
}
