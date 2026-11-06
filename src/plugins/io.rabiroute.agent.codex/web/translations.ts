export const pluginTranslations = {
  "en": {
    "桌面宿主": "Desktop host",
    "实际消息只交给 Codex/ChatGPT Desktop 当前任务执行，因此桌面端会立即显示消息并沿用该任务的工具、模型与权限。Desktop 未启动或目标任务无法加载时会明确失败，不会启动备用 Runtime。": "Real messages are executed only by the selected Codex/ChatGPT Desktop task, so they appear in Desktop immediately and use that task's tools, model, and permissions. If Desktop is unavailable or the task cannot be loaded, delivery fails explicitly; no fallback runtime is started.",
    "用于同名任务的自动查找和新建；选择已有任务时会自动采用任务自己的目录": "Used to find or create a task with the same name. Selecting an existing task automatically uses that task's own directory.",
    "每次读取 200 个 Desktop 任务且不显示 ID；可继续加载，输入名称后只查找，唯一匹配就绑定，没有匹配则在点击保存时创建": "Loads 200 Desktop tasks at a time without exposing IDs. More pages can be loaded; entering a name only searches, a unique match is bound, and a missing task is created on save.",
    "消息由桌面任务执行并实时显示": "Messages run in the Desktop task and appear there in real time"
  },
  "ja": {
    "桌面宿主": "Desktopホスト",
    "实际消息只交给 Codex/ChatGPT Desktop 当前任务执行，因此桌面端会立即显示消息并沿用该任务的工具、模型与权限。Desktop 未启动或目标任务无法加载时会明确失败，不会启动备用 Runtime。": "実際のメッセージは、選択された Codex/ChatGPT Desktop タスクによってのみ実行されるため、すぐに Desktop に表示され、そのタスクのツール、モデル、および権限が使用されます。 Desktop が使用できない場合、またはタスクをロードできない場合、配信は明示的に失敗します。フォールバック ランタイムは開始されません。",
    "用于同名任务的自动查找和新建；选择已有任务时会自动采用任务自己的目录": "同じ名前のタスクを検索または作成するために使用されます。既存のタスクを選択すると、そのタスク独自のディレクトリが自動的に使用されます。",
    "每次读取 200 个 Desktop 任务且不显示 ID；可继续加载，输入名称后只查找，唯一匹配就绑定，没有匹配则在点击保存时创建": "IDを公開せずに、一度に200のDesktopタスクをロードします。より多くのページをロードできます。名前を入力すると検索のみが行われ、一意の一致がバインドされ、保存時に欠落しているタスクが作成されます。",
    "消息由桌面任务执行并实时显示": "メッセージは Desktop タスク内で実行され、リアルタイムでそこに表示されます"
  }
} as const;
