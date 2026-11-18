/** Installed-handler/example-shaped test data. These values never contact a platform. */
export const napcatResultProfileFixtures: Readonly<Record<string, unknown>> = {
  ArkShareGroup: JSON.stringify({app:"com.tencent.structmsg",view:"contact",ver:"1",meta:{url:"https://example.invalid/?token=example-secret"}}),
  ArkSharePeer: JSON.stringify({app:"com.tencent.structmsg",view:"contact",ver:"1",meta:{url:"https://example.invalid/?token=example-secret"}}),
  send_group_ark_share: JSON.stringify({app:"com.tencent.structmsg",view:"contact",ver:"1",meta:{url:"https://example.invalid/?token=example-secret"}}),
  send_ark_share: JSON.stringify({app:"com.tencent.structmsg",view:"contact",ver:"1",meta:{url:"https://example.invalid/?token=example-secret"}}),

  get_doubt_friends_add_request: [{ flag: "example-acceptance-capability", uin: "12345", nick: "Example", source: "group", reason: "request", msg: "hello", group_code: "789", time: "123", type: "doubt" }],
  get_group_honor_info: { group_id: 789, current_talkative: { user_id: "12345", nickname: "Example", avatar: "https://example.invalid/?rkey=example-secret" },
    talkative_list: [{ user_id: "12345", nickname: "Example", description: "active", avatar: "https://example.invalid/private" }],
    performer_list: [], legend_list: [], emotion_list: [], strong_newbie_list: [] },
  get_mini_app_ark: { data: { ver: "1", prompt: "Example", app: "example.app", view: "example.view", config: { token: "example-secret" }, meta: { url: "https://example.invalid/private" } } },
  get_collection_list: { errCode: 0, errMsg: "example-secret", collectionSearchList: {
    collectionItemList: [{ cid: "123", type: 8, status: 1, category: 1, createTime: "123", author: { type: 2, numId: "12345", strId: "Example" }, shareUrl: "https://example.invalid/?token=example-secret" }],
    hasMore: false, bottomTimeStamp: "123" } },
  get_qun_album_list: { album_list: [{ album_id: "album", album_name: "Example", create_time: 123, cover_url: "https://example.invalid/?token=example-secret" }], attach_info: "example-cursor", has_more: true },
  get_group_album_media_list: { media_list: [{ media_id: "media", url: "https://example.invalid/?token=example-secret" }] },
  get_robot_uin_range: [{ minUin: "10000000000000001", maxUin: "10000000000000099", internal: "example-secret" }],
  get_group_shut_list: [{ user_id: 12345, nickname: "Example", shut_up_time: 123, internal: "example-secret" }],
  get_fileset_info: { result: 0, file_list: [{ path: "example-secret" }] },
  get_flash_file_list: { result: 0, errMs: "example-secret", files: [{ url: "https://example.invalid/private" }] },
  get_group_info_ex: { groupOwnerId: "12345", unknown: "example-secret" },
  get_online_file_msg: [{ url: "https://example.invalid/?token=example-secret" }],
  get_cookies: { cookies: "example-cookie-material", bkn: "example-csrf-material" },
  get_credentials: { cookies: "example-cookie-material", token: 987654321 },
  get_csrf_token: { token: 987654321 },
  get_clientkey: { clientkey: "example-client-key-material" },
  nc_get_rkey: [{ type: 10, rkey: "example-rkey-material", time: "123", ttl: "60" }],
  get_rkey: [{ type: "group", rkey: "example-rkey-material", created_at: 123, ttl: 60 }],
  get_rkey_server: { private_rkey: "example-private-rkey", group_rkey: "example-group-rkey", expired_time: 456, name: "NapCat 4" }
};
