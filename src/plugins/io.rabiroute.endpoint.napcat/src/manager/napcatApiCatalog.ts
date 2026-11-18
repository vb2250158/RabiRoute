import type { ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import type { NapcatApiDescriptor } from "./napcatApiOperations.js";
import { napcatApiAttachmentSourceSchema, type NapcatApiAttachmentInput } from "./napcatApiAttachments.js";
import { napcatApiResultProfile } from "./napcatApiResultProfiles.js";
import { napcatCacheMaintenanceActions, napcatCacheMaintenanceDescription } from "../native/cacheMaintenance.js";
import { napcatOnlineTransferActions, napcatOnlineTransferDescription } from "../native/onlineTransfers.js";
import { inlineKeyboardParameters, inlineKeyboardDescription } from "../native/inlineKeyboard.js";

type SchemaContract = { resolved: boolean; schema: Record<string, unknown> };
export type NapcatApiManifest = {
  source: { version: string; bundleSha256: string };
  actions: Array<{ action: string; aliases: string[]; summary: string; description: string; testOnly: boolean;
    payloadContract: SchemaContract; returnContract: SchemaContract }>;
};

const references: Readonly<Record<string, string>> = {
  get_msg: "agent.qq.message.read", get_group_msg_history: "agent.qq.history.read", get_friend_msg_history: "agent.qq.history.read",
  get_forward_msg: "agent.qq.forward.read", get_file: "agent.qq.attachment.read", get_image: "agent.qq.attachment.read", get_record: "agent.qq.attachment.read",
  get_group_list: "agent.qq.contacts.read", get_friend_list: "agent.qq.contacts.read", get_recent_contact: "agent.qq.contacts.read",
  get_group_member_list: "agent.qq.members.read", get_group_root_files: "agent.qq.group-files.read", get_group_files_by_folder: "agent.qq.group-files.read",
  fetch_custom_face: "agent.qq.stickers.read", set_restart: "manager.napcat.restart",
  send_msg: "agent.send", send_group_msg: "agent.send", send_private_msg: "agent.send", send_forward_msg: "agent.send",
  send_private_forward_msg: "agent.send", send_group_forward_msg: "agent.send", forward_friend_single_msg: "agent.send", forward_group_single_msg: "agent.send",
  upload_group_file: "agent.send", upload_private_file: "agent.send",
  send_group_ai_record: "agent.send", send_flash_msg: "agent.send", send_online_file: "agent.send", send_online_folder: "agent.send"
};

const outboundProducerDependencies = new Set([
  "send_forward_msg", "send_private_forward_msg", "send_group_forward_msg", "forward_friend_single_msg", "forward_group_single_msg",
  "send_group_ai_record", "send_flash_msg", "send_online_file", "send_online_folder"
]);

const reads = new Set([
  "get_login_info", "get_group_info", "get_group_member_info", "get_version_info", "can_send_record", "can_send_image", "get_status",
  "get_stranger_info", "get_robot_uin_range", "get_essence_msg_list", "get_friends_with_category", "get_group_honor_info",
  "get_group_ignored_notifies", "get_online_clients", "get_profile_like", "get_emoji_likes", "get_group_file_system_info", "get_group_system_msg",
  "nc_get_packet_status", "nc_get_user_status", "get_group_shut_list", "get_group_at_all_remain", "_get_model_show", "check_url_safely",
  "get_ai_characters", "get_guild_list", "get_guild_service_profile", "get_unidirectional_friend_list", "get_group_detail_info", "get_group_ignore_add_request",
  "get_fileset_id", "translate_en2zh", "_get_group_notice"
]);
const mutations = new Set([
  "delete_msg", "send_like", "set_group_add_request", "set_group_leave", "set_friend_add_request", "set_group_whole_ban", "set_group_name",
  "set_group_ban", "set_group_kick", "set_group_admin", "set_group_card", "mark_private_msg_as_read", "mark_group_msg_as_read", "mark_msg_as_read",
  "_mark_all_as_read", "set_msg_emoji_like", "set_online_status", "set_qq_profile", "create_collection", "set_self_longnick", "delete_essence_msg",
  "set_essence_msg", "set_input_status", "_del_group_notice", "delete_group_file", "create_group_file_folder", "delete_group_folder",
  "set_group_special_title", "set_group_sign", "send_group_sign", "_set_model_show", "delete_friend", "send_poke", "group_poke", "friend_poke",
  "set_diy_online_status", "set_group_remark", "move_group_file", "trans_group_file", "rename_group_file", "set_friend_remark",
  "set_doubt_friends_add_request", "set_group_add_option", "set_group_search", "set_group_robot_add_option", "set_group_kick_members",
  "complete_group_todo", "cancel_group_todo", "set_group_todo", "set_group_album_media_like", "cancel_group_album_media_like", "del_group_album_media",
  "click_inline_keyboard_button", "download_fileset"
]);
const dependencies: Readonly<Record<string, string>> = {
  get_cookies: "Protected credential result handles are required for cookies and bkn.",
  get_credentials: "Protected credential result handles are required for cookies and token.",
  get_csrf_token: "Protected credential result handles are required for token.",
  get_clientkey: "Protected credential result handles are required for clientkey.",
  nc_get_rkey: "Protected credential result handles are required for rkey.",
  get_rkey: "Protected credential result handles are required for rkey.",
  get_rkey_server: "Protected credential result handles are required for private_rkey and group_rkey.",
  send_packet: "Raw packet service, command and byte payload need the original protocol execution owner.",
  bot_exit: "An account-preserving process exit operation is required; removing the configured instance has different effects.",
  ".handle_quick_operation": "The original incoming event owner must retain and validate the request context and its reply actions.",
  download_file: "Host filesystem downloads require an owned destination and safe file/URL input handles.",
  download_file_stream: "Native file streaming requires the original stream and owned destination lifecycle.",
  download_file_record_stream: "Native audio streaming requires the original stream and owned destination lifecycle.",
  download_file_image_stream: "Native image streaming requires the original stream and owned destination lifecycle.",
  upload_file_stream: "Native file streaming requires existing upload ownership and stream lifecycle.",
  set_qq_avatar: "Avatar file/URL inputs require a managed attachment or upload handle.",
  set_group_portrait: "Portrait file/URL inputs require a managed attachment or upload handle.",
  ocr_image: "OCR image input requires a managed attachment or upload handle.",
  ".ocr_image": "OCR image input requires a managed attachment or upload handle.",
  _send_group_notice: "The notice's text and optional image require the original outbound and attachment owners.",
  do_group_album_comment: "Album comment text requires a managed outbound action adapter.",
  upload_image_to_qun_album: "Album image upload requires an owned attachment handle.",
  fetch_ptt_text: "Voice file and URL inputs require a managed attachment handle.",
  get_ai_record: "Generated audio URLs require a managed resource handle.",
  get_group_file_url: "Signed group file URLs require a managed file resource handle.",
  get_private_file_url: "Signed private file URLs require a managed file resource handle.",
  fetch_emoji_like: "The provider cookie cursor requires an opaque pagination handle.",
};

// These reviewed DTOs preserve declared diagnostic fields while leaving opaque records and resource URLs with their owner.
const resultProjections: Readonly<Record<string, Record<string, unknown>>> = {
  ocr_image: { type: "object", additionalProperties: false, required: ["texts"], properties: {
    texts: { type: "array", items: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } } }
  } },
  ".ocr_image": { type: "object", additionalProperties: false, required: ["texts"], properties: {
    texts: { type: "array", items: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } } }
  } },
  _get_group_notice: { type: "array", items: { type: "object", additionalProperties: false, required: ["sender_id", "publish_time", "notice_id", "message"], properties: {
    sender_id: { type: "number" }, publish_time: { type: "number" }, notice_id: { type: "string" },
    message: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } }, read_num: { type: "number" }
  } } },
  get_essence_msg_list: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["msg_seq", "msg_random", "sender_id", "sender_nick", "operator_id", "operator_nick", "message_id", "operator_time"], properties: {
      msg_seq: { type: "number" }, msg_random: { type: "number" }, sender_id: { type: "number" }, sender_nick: { type: "string" },
      operator_id: { type: "number" }, operator_nick: { type: "string" }, message_id: { type: "number" }, operator_time: { type: "number" }
    } } },
  // The installed handler initiates its native refresh and unconditionally returns an empty list.
  get_online_clients: { type: "array", maxItems: 0, items: { type: "object", additionalProperties: false } },
  get_group_ignored_notifies: { type: "object", additionalProperties: false, required: ["invited_requests", "InvitedRequest", "join_requests"], properties:
    Object.fromEntries(["invited_requests", "InvitedRequest", "join_requests"].map(name => [name, { type: "array", items: {
      type: "object", additionalProperties: false, properties: { request_id: { type: "number" }, invitor_uin: { type: "number" },
        invitor_nick: { type: "string" }, group_id: { type: "number" }, message: { type: "string" }, group_name: { type: "string" },
        checked: { type: "boolean" }, actor: { type: "number" }, requester_nick: { type: "string" } }
    } }])) },
  get_status: { type: "object", additionalProperties: false, required: ["online", "good"], properties: {
    online: { type: "boolean" }, good: { type: "boolean" }
  } },
  get_ai_characters: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "characters"], properties: {
    type: { type: "string" }, characters: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["character_id", "character_name"], properties: { character_id: { type: "string" }, character_name: { type: "string" } } } }
  } } },
  get_profile_like: { type: "object", additionalProperties: false, required: ["uid", "time", "favoriteInfo", "voteInfo"], properties: {
    uid: { type: "string" }, time: { type: "string" },
    favoriteInfo: { type: "object", additionalProperties: false, required: ["total_count", "last_time", "today_count"], properties: {
      total_count: { type: "number" }, last_time: { type: "number" }, today_count: { type: "number" }
    } },
    voteInfo: { type: "object", additionalProperties: false, required: ["total_count", "new_count", "new_nearby_count", "last_visit_time"], properties: {
      total_count: { type: "number" }, new_count: { type: "number" }, new_nearby_count: { type: "number" }, last_visit_time: { type: "number" }
    } }
  } }
};

const attachmentInputs: Readonly<Record<string, NapcatApiAttachmentInput>> = {
  set_qq_avatar: "image-file", set_group_portrait: "image-file", ocr_image: "ocr-image", ".ocr_image": "ocr-image", fetch_ptt_text: "audio-message"
};

function cleanSchema(schema: Record<string, unknown>, closeObjects = true): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-") || key === "$id") continue;
    if (Array.isArray(value)) next[key] = value.map(child => child && typeof child === "object" && !Array.isArray(child) ? cleanSchema(child as Record<string, unknown>, closeObjects) : child);
    else if (value && typeof value === "object") {
      next[key] = ["properties", "patternProperties", "$defs", "definitions"].includes(key)
        ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, cleanSchema(child as Record<string, unknown>, closeObjects)]))
        : cleanSchema(value as Record<string, unknown>, closeObjects);
    } else next[key] = value;
  }
  if (closeObjects && next.type === "object" && !Object.hasOwn(next, "additionalProperties")) next.additionalProperties = false;
  return next;
}

function responseNeedsOwner(schema: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties && Object.keys(properties).some(key => /(?:^|_)(?:cookies?|tokens?|clientkey|rkey|base64|url)(?:$|_)/i.test(key))) return true;
  if (!schema.type && !schema.enum && !Object.hasOwn(schema, "const") && !schema.anyOf && !schema.oneOf && !schema.allOf) return true;
  return Object.entries(schema).some(([key, value]) => key === "properties" || key === "patternProperties"
    ? Object.values(value as Record<string, Record<string, unknown>>).some(responseNeedsOwner)
    : ["items", "additionalProperties"].includes(key) && typeof value === "object" && value !== null
      ? responseNeedsOwner(value as Record<string, unknown>)
      : ["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(value)
        ? value.some(child => responseNeedsOwner(child as Record<string, unknown>)) : false);
}

/** Execute policy is explicit per reviewed action; upstream declarations remain unmodified facts. */
export function createNapcatApiDescriptors(manifest: NapcatApiManifest): readonly NapcatApiDescriptor[] {
  if (manifest.source.version !== "4.18.4" || manifest.source.bundleSha256 !== "66dfaa1b9e7530d493089c70d24810f4e23c31d129e1662949558ce30ce52a92") {
    throw new Error("NapCat API declarations do not match the reviewed distribution.");
  }
  return manifest.actions.map(row => {
    let parameters = row.payloadContract.schema["x-upstream-schema-absent"] === true
      ? { type: "object", properties: {}, additionalProperties: false } : cleanSchema(row.payloadContract.schema);
    const nativeParameters = parameters;
    const requestEventInput = row.action === "set_friend_add_request" || row.action === "set_group_add_request";
    if (requestEventInput) {
      const properties = nativeParameters.properties as Record<string, Record<string, unknown>>;
      const extras = row.action === "set_friend_add_request" ? { remark: properties.remark }
        : { reason: properties.reason, count: properties.count, sub_type: { enum: ["add", "invite"] } };
      parameters = { oneOf: [nativeParameters, { type: "object", additionalProperties: false, required: ["eventRef", "approve"], properties: {
        eventRef: { type: "string", pattern: "^[a-f0-9]{64}$" }, approve: { type: "boolean" }, ...extras
      } }] };
    }
    const sourceResponse = cleanSchema(row.returnContract.schema);
    let mode: NapcatApiDescriptor["mode"] = "managed";
    const managedOwner = references[row.action];
    const attachmentInput = attachmentInputs[row.action];
    const resultProfile = napcatApiResultProfile(row.action);
    if (row.action === "click_inline_keyboard_button") parameters = inlineKeyboardParameters;
    if (row.action === "get_cookies" || row.action === "get_credentials") {
      const properties = parameters.properties as Record<string, Record<string, unknown>>;
      parameters = { ...parameters, properties: { ...properties, domain: { ...properties.domain, maxLength: 253,
        pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\\.?(?![\\s\\S])" } } };
    }
    let unavailableReason = row.testOnly ? "Upstream test interface; excluded from ordinary platform execution." : attachmentInput || resultProfile ? undefined : dependencies[row.action];
    if (outboundProducerDependencies.has(row.action)) unavailableReason = "The managed outbound owner agent.send does not yet provide this native forward/Ark/AI/flash/online-transfer producer. Its generic send contract is not a substitute for this shape.";
    if (attachmentInput) {
      const nativeField = attachmentInput === "audio-message" ? "message_id" : attachmentInput === "ocr-image" ? "image" : "file";
      const nativeProperties = parameters.properties as Record<string, unknown>;
      parameters = { ...parameters, properties: { ...Object.fromEntries(Object.entries(nativeProperties).filter(([name]) => name !== nativeField)), attachment: napcatApiAttachmentSourceSchema },
        required: [...((parameters.required ?? []) as string[]).filter(name => name !== nativeField), "attachment"] };
      mode = attachmentInput === "ocr-image" ? "read" : "mutation";
    }
    if (resultProfile) mode = "read";
    if (!managedOwner && !unavailableReason && !attachmentInput && !resultProfile) {
      if (reads.has(row.action) && (resultProjections[row.action] || !responseNeedsOwner(sourceResponse))) mode = "read";
      else if (mutations.has(row.action) || napcatCacheMaintenanceActions.has(row.action) || napcatOnlineTransferActions.has(row.action)) mode = "mutation";
      else unavailableReason = responseNeedsOwner(sourceResponse)
        ? "A reviewed public result projection is required for this opaque or sensitive native response."
        : "An action-specific execution owner is required for this platform or resource operation.";
    }
    const response = resultProfile?.schema ?? resultProjections[row.action] ?? (mode === "mutation" && (responseNeedsOwner(sourceResponse) || attachmentInput === "image-file") ? { type: "null" } : sourceResponse);
    return { action: row.action, aliases: row.aliases, title: row.summary, version: manifest.source.version,
      description: [row.description || row.summary, managedOwner ? `Existing owner ${managedOwner} retains its original supported shapes and input contract.` : "", unavailableReason,
        mode === "mutation" && response !== sourceResponse ? "This mutation exposes acknowledgement and its durable receipt; opaque native result fields stay private." : "",
        resultProjections[row.action] ? "The public DTO contains reviewed metadata only; opaque records and native resource URLs are omitted." : "",
        attachmentInput ? "Select an attachment by exact source chat, message ID and index. The original media owner supplies bytes internally; native file/URL/base64 inputs are not public parameters." : "",
        resultProfile?.description, napcatCacheMaintenanceActions.has(row.action) ? napcatCacheMaintenanceDescription : "",
        napcatOnlineTransferActions.has(row.action) ? napcatOnlineTransferDescription : "",
        row.action === "click_inline_keyboard_button" ? inlineKeyboardDescription : "",
        row.action === "download_fileset" ? "Native request acknowledgement only. The selected platform owns its fixed download destination; no caller path is accepted. This does not prove downloaded bytes or completion." : ""].filter(Boolean).join(" "),
      parameters, response, nativeResponse: cleanSchema(row.returnContract.schema, false), mode, managedOwner, unavailableReason,
      attachmentInput,
      sourceInput: row.action === "click_inline_keyboard_button" ? "inline-keyboard" : requestEventInput ? "request-event" : undefined,
      nativeParameters: requestEventInput ? nativeParameters : undefined,
      nativeAcknowledgement: row.action === "download_fileset" ? "result-zero" : undefined,
      resultProfile: resultProfile ? row.action : undefined,
      relatedOperations: managedOwner ? [managedOwner] : row.action === "get_essence_msg_list" ? ["agent.qq.message.read"] : undefined };
  });
}
