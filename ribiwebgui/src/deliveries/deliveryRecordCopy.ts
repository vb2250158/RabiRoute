export type DeliveryRecordLocale = "zh-CN" | "en" | "ja";

const chinese = {
  title: "投递记录", intro: "查看消息是否已交给目标任务，以及仍在等待的原因。",
  coverage: "这里只显示主机已保存的投递记录。断线电脑尚未同步的本地待发消息不在此列表中。",
  nodeCoverage: "这里只显示所选电脑当前可读取的本地投递记录。该电脑断线时无法取得最新记录。",
  computer: "记录所在电脑", hostComputer: "当前主机", online: "在线", offline: "离线", selectedComputer: "已选电脑", computerReadFailed: "电脑列表读取失败。仍可查看当前主机记录。", unavailable: "当前无法读取所选电脑的最新记录。保留上次读取时间；连接恢复后刷新。",
  search: "搜索投递编号或任务 ID", state: "投递状态", allStates: "全部状态", apply: "查询", refresh: "刷新",
  loading: "正在读取投递记录…", empty: "没有匹配的投递记录。", loadMore: "加载更多", details: "查看详情",
  source: "来源", target: "目标", updated: "最后更新", created: "记录时间", attempts: "尝试次数",
  lastAttempt: "最后尝试", nextAttempt: "下次尝试", receivedAt: "目标接收时间", reason: "当前原因",
  errorCode: "错误编号", unknown: "未记录", unknownState: "状态未知", manager: "主机", node: "客户端",
  owner: "记录位置", deliveryId: "投递编号", intentId: "调用编号", observedAt: "读取时间",
  close: "关闭", detailLoading: "正在读取详情…", receipt: "接收证据", receiptNote: "仅展示服务保存的接收证据，不会重新发送消息。",
  receivedNote: "目标已接收表示消息已进入目标任务；实际处理结果请查看对应任务。",
  loadFailed: "投递记录读取失败。", records: "条记录", copyId: "复制投递编号", copied: "已复制", copyFailed: "复制失败，请手动选择编号。",
  refreshNote: "记录按读取时间显示；刷新可查看最新状态。", detailsTitle: "投递详情"
};
type Copy = { [Key in keyof typeof chinese]: string };

const english: Copy = {
  title: "Delivery records", intro: "See whether a message reached its target task and why it is still waiting.",
  coverage: "This list contains records saved by the host. Unsent messages on disconnected computers are not included until synchronized.",
  nodeCoverage: "This list contains delivery records read from the selected computer. Current records are unavailable while that computer is disconnected.",
  computer: "Computer", hostComputer: "Current host", online: "Online", offline: "Offline", selectedComputer: "Selected computer", computerReadFailed: "Could not load the computer list. Host records are still available.", unavailable: "Current records from this computer are unavailable. Any displayed records retain their previous read time. Refresh after connection recovers.",
  search: "Search delivery or task ID", state: "Delivery status", allStates: "All statuses", apply: "Search", refresh: "Refresh",
  loading: "Loading delivery records…", empty: "No matching delivery records.", loadMore: "Load more", details: "View details",
  source: "From", target: "To", updated: "Last updated", created: "Recorded at", attempts: "Attempts",
  lastAttempt: "Last attempt", nextAttempt: "Next attempt", receivedAt: "Target accepted at", reason: "Current reason",
  errorCode: "Error code", unknown: "Not recorded", unknownState: "Unknown status", manager: "Host", node: "Client",
  owner: "Record owner", deliveryId: "Delivery ID", intentId: "Intent ID", observedAt: "Read at",
  close: "Close", detailLoading: "Loading details…", receipt: "Acceptance evidence", receiptNote: "Shows saved acceptance evidence. Viewing records never resends a message.",
  receivedNote: "Accepted means the message entered the target task. Check that task for its processing result.",
  loadFailed: "Could not load delivery records.", records: "records", copyId: "Copy delivery ID", copied: "Copied", copyFailed: "Could not copy. Select the ID manually.",
  refreshNote: "Records reflect the displayed read time. Refresh to check for changes.", detailsTitle: "Delivery details"
};

const japanese: Copy = {
  title: "配信記録", intro: "対象タスクがメッセージを受け取ったか、待機している理由を確認できます。",
  coverage: "ホストが保存した記録を表示します。接続が切れた端末の未同期の送信待ちメッセージは含まれません。",
  nodeCoverage: "選択した端末のローカル配信記録を表示します。その端末の接続が切れている間は最新の記録を取得できません。",
  computer: "記録のある端末", hostComputer: "現在のホスト", online: "オンライン", offline: "オフライン", selectedComputer: "選択した端末", computerReadFailed: "端末一覧を読み込めませんでした。現在のホストの記録は確認できます。", unavailable: "選択した端末の最新の記録を取得できません。表示中の記録の読込日時は更新されません。接続の復旧後に更新してください。",
  search: "配信 ID またはタスク ID を検索", state: "配信状態", allStates: "すべての状態", apply: "検索", refresh: "更新",
  loading: "配信記録を読み込み中…", empty: "一致する配信記録はありません。", loadMore: "さらに読み込む", details: "詳細を表示",
  source: "送信元", target: "送信先", updated: "最終更新", created: "記録日時", attempts: "試行回数",
  lastAttempt: "最終試行", nextAttempt: "次の試行", receivedAt: "対象の受信日時", reason: "現在の理由",
  errorCode: "エラーコード", unknown: "記録なし", unknownState: "状態不明", manager: "ホスト", node: "クライアント",
  owner: "記録の保存先", deliveryId: "配信 ID", intentId: "呼び出し ID", observedAt: "読込日時",
  close: "閉じる", detailLoading: "詳細を読み込み中…", receipt: "受信証跡", receiptNote: "保存済みの受信証跡を表示します。記録の表示でメッセージが再送信されることはありません。",
  receivedNote: "受信済みは対象タスクへの到達を示します。処理結果は対象タスクで確認してください。",
  loadFailed: "配信記録を読み込めませんでした。", records: "件", copyId: "配信 ID をコピー", copied: "コピーしました", copyFailed: "コピーできませんでした。ID を手動で選択してください。",
  refreshNote: "記録は表示された読込日時の状態です。最新の状態は更新して確認してください。", detailsTitle: "配信の詳細"
};

export function deliveryRecordCopy(locale: DeliveryRecordLocale): Copy {
  return locale === "en" ? english : locale === "ja" ? japanese : chinese;
}

export const deliveryStateLabels: Record<DeliveryRecordLocale, Record<string, string>> = {
  "zh-CN": { local_accepted: "本地已受理", queued: "待发送", sending: "发送中", awaiting_confirmation: "待确认", received: "目标已接收", blocked: "已阻塞", failed: "明确失败", cancelled: "已取消" },
  en: { local_accepted: "Accepted locally", queued: "Queued", sending: "Sending", awaiting_confirmation: "Awaiting confirmation", received: "Accepted by target", blocked: "Blocked", failed: "Failed", cancelled: "Cancelled" },
  ja: { local_accepted: "端末で受付済み", queued: "送信待ち", sending: "送信中", awaiting_confirmation: "確認待ち", received: "対象が受信済み", blocked: "ブロック中", failed: "失敗確定", cancelled: "キャンセル済み" }
};
