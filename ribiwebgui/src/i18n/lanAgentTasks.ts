import type { AppLocale } from "./index";

export const recentTaskCopy = {
  "zh-CN": { title: "最近任务", node: "节点", status: "状态", updatedAt: "更新时间", result: "结果", empty: "暂无任务记录。" },
  en: { title: "Recent tasks", node: "Node", status: "Status", updatedAt: "Updated", result: "Result", empty: "No task records yet." },
  ja: { title: "最近のタスク", node: "ノード", status: "ステータス", updatedAt: "更新日時", result: "結果", empty: "タスク履歴はありません。" }
} satisfies Record<AppLocale, Record<string, string>>;

const taskStatuses = new Map<string, Record<AppLocale, string>>([
  ["queued", { "zh-CN": "排队中", en: "Queued", ja: "待機中" }],
  ["delivered", { "zh-CN": "已投递", en: "Delivered", ja: "配信済み" }],
  ["acknowledged", { "zh-CN": "已接收", en: "Acknowledged", ja: "受信済み" }],
  ["progress", { "zh-CN": "进行中", en: "In progress", ja: "進行中" }],
  ["completed", { "zh-CN": "已完成", en: "Completed", ja: "完了" }],
  ["failed", { "zh-CN": "失败", en: "Failed", ja: "失敗" }],
  ["interrupted", { "zh-CN": "已中断", en: "Interrupted", ja: "中断" }]
]);

// Older connectors and stored records carry the original English messages.
const taskMessages = new Map<string, Record<"zh-CN" | "ja", string>>([
  ["The selected Codex task is busy. Wait for its current task to finish before submitting another message.", {
    "zh-CN": "所选 Codex 会话正忙。请等当前任务结束后再发送消息。",
    ja: "選択した Codex セッションは使用中です。現在のタスクが終わってからメッセージを送信してください。"
  }],
  ["Codex Desktop accepted the task. Rabi Agent is waiting for its task state.", {
    "zh-CN": "Codex Desktop 已接收任务，Rabi Agent 正在等待状态更新。",
    ja: "Codex Desktop がタスクを受け付けました。Rabi Agent はステータスの更新を待っています。"
  }],
  ["Codex Desktop IPC thread-follower-start-turn failed: no-client-found", {
    "zh-CN": "Codex Desktop 投递失败，未找到会话客户端（no-client-found）。",
    ja: "Codex Desktop への配信に失敗しました。セッションのクライアントが見つかりません（no-client-found）。"
  }],
  ["This task was already accepted; it will not be submitted twice.", {
    "zh-CN": "此任务已接收，无需重复提交。",
    ja: "このタスクは受け付け済みです。重複送信は行いません。"
  }],
  ["Rabi Agent deduplicated an already terminal task.", {
    "zh-CN": "此任务已结束，Rabi Agent 已跳过重复请求。",
    ja: "このタスクは終了済みです。Rabi Agent は重複したリクエストをスキップしました。"
  }],
  ["DSH accepted the message into the bound session queue. Read the response in that DSH session.", {
    "zh-CN": "DSH 已将消息加入绑定会话的队列。请在该 DSH 会话中查看回复。",
    ja: "DSH はメッセージを紐付け先セッションのキューに追加しました。その DSH セッションで応答を確認してください。"
  }],
  ["Codex Desktop reported that the target task is complete. Open that task owner to read its response.", {
    "zh-CN": "Codex Desktop 已报告任务完成。请打开对应会话查看回复。",
    ja: "Codex Desktop がタスクの完了を報告しました。該当のセッションを開いて応答を確認してください。"
  }],
  ["Codex Desktop reported that the target task did not complete.", {
    "zh-CN": "Codex Desktop 报告目标任务未完成。",
    ja: "Codex Desktop は対象タスクが完了しなかったと報告しました。"
  }],
  ["Codex Desktop reported task failure.", {
    "zh-CN": "Codex Desktop 报告任务失败。",
    ja: "Codex Desktop がタスクの失敗を報告しました。"
  }],
  ["Original Manager connection is unavailable; queued task execution was refused.", {
    "zh-CN": "无法连接原 Manager，排队中的任务未执行。",
    ja: "元の Manager に接続できないため、待機中のタスクは実行されませんでした。"
  }],
  ["The original Agent plugin is unavailable.", {
    "zh-CN": "原 Agent 插件不可用。",
    ja: "元の Agent プラグインを利用できません。"
  }],
  ["Rabi Agent task message is empty.", {
    "zh-CN": "Rabi Agent 收到的任务消息为空。",
    ja: "Rabi Agent が受信したタスクメッセージが空です。"
  }],
  ["Original task Manager binding changed before authority verification.", {
    "zh-CN": "权限校验前，任务绑定的 Manager 已变更。",
    ja: "権限を確認する前に、タスクに紐付けられた Manager が変更されました。"
  }],
  ["Manager no longer authorizes this Agent task; host execution was refused.", {
    "zh-CN": "Manager 未确认此 Agent 任务的授权，宿主未执行任务。",
    ja: "Manager がこの Agent タスクの許可を確認できなかったため、ホストは実行しませんでした。"
  }],
  ["Original Manager connection changed before host task execution.", {
    "zh-CN": "宿主执行任务前，与原 Manager 的连接已变更。",
    ja: "ホストがタスクを実行する前に、元の Manager への接続が変更されました。"
  }],
  ["Manager endpoint discovery failed or is cooling down.", {
    "zh-CN": "未能找到 Manager，或正在等待下次发现。",
    ja: "Manager の検出に失敗したか、次の検出まで待機中です。"
  }]
]);

const taskMessagePrefixes = [
  ["Codex Desktop IPC thread-follower-start-turn failed: ", {
    "zh-CN": "Codex Desktop IPC 启动会话任务失败：",
    ja: "Codex Desktop IPC でタスクを開始できませんでした："
  }],
  ["Rabi Agent task workspace is outside the declared allowed workspaces: ", {
    "zh-CN": "任务工作目录不在 Rabi Agent 允许的范围内：",
    ja: "タスクの作業ディレクトリが Rabi Agent の許可範囲外です："
  }],
  ["Codex Desktop is not ready; Rabi Agent does not start a fallback runtime. ", {
    "zh-CN": "Codex Desktop 尚未就绪，Rabi Agent 未启动任务。 ",
    ja: "Codex Desktop の準備が整っていないため、Rabi Agent はタスクを開始しませんでした。 "
  }]
] as const;

export function lanAgentTaskStatus(status: string, locale: AppLocale): string {
  return taskStatuses.get(status)?.[locale] ?? status;
}

export function lanAgentTaskMessage(message: string, locale: AppLocale): string {
  if (locale === "en") return message;
  const translated = taskMessages.get(message)?.[locale];
  if (translated) return translated;
  for (const [prefix, copy] of taskMessagePrefixes) {
    if (message.startsWith(prefix)) return copy[locale] + message.slice(prefix.length);
  }
  return message;
}
