export const pluginTranslations = {
  "en": {
    "开启（hot）：每段 ASR 立即投递。关闭（keyword）：未命中关键词时只记录，命中当前角色关键词时才投递。": "On (hot): deliver every ASR segment immediately. Off (keyword): record without waking when no keyword matches, and deliver only when a current-role keyword matches.",
    "当前角色没有语音唤醒关键词。关闭热投递后，转写仍会记录，但不会唤醒 Agent。": "The current role has no speech wake-up keywords. With Hot delivery off, transcripts are still recorded but the Agent will not wake.",
    "配置角色关键词": "Configure role keywords",
    "声音风格": "Voice style",
    "由角色 voice-profile 配置": "Configured by role voice-profile",
    "Agent 回复自动排队播放": "Queue Agent replies for playback",
    "当前 Route 只负责订阅主机 ASR 广播、热投递/角色关键词策略和是否播放回复。ASR 模型、麦克风、VAD 与切句参数属于整台电脑，请到“语音服务”统一设置；TTS 模型、声线、语言、语速和发声说明归当前角色的": "This Route owns only host-ASR subscription, hot/role-keyword policy, and reply playback. The ASR model, microphone, VAD, and segmentation belong to the host and are configured on Speech Service. TTS model, voice, language, speed, and speaking instructions belong to the current role's",
    "主机只做一次 ASR，再把同一份文字广播给订阅 Route；不会为每个角色重复占用麦克风或重复跑识别模型。": "The host runs ASR once and broadcasts the same text to subscribed Routes; it does not duplicate microphone capture or recognition for each role."
  },
  "ja": {
    "开启（hot）：每段 ASR 立即投递。关闭（keyword）：未命中关键词时只记录，命中当前角色关键词时才投递。": "オン(ホット):すべてのASRセグメントを直ちに配信する。オフ (キーワード): キーワードが一致しない場合は起動せずに記録し、現在のペルソナのキーワードが一致した場合にのみ配信します。",
    "当前角色没有语音唤醒关键词。关闭热投递后，转写仍会记录，但不会唤醒 Agent。": "現在のペルソナには、音声ウェイクアップキーワードが存在しない。ホット配信がオフの場合、トランスクリプトは記録されますが、Agent は起動しません。",
    "配置角色关键词": "ロールキーワードを設定する",
    "声音风格": "声のスタイル",
    "由角色 voice-profile 配置": "ペルソナの音声プロファイルによって構成されます",
    "Agent 回复自动排队播放": "再生のために Agent 応答をキューに入れます",
    "当前 Route 只负责订阅主机 ASR 广播、热投递/角色关键词策略和是否播放回复。ASR 模型、麦克风、VAD 与切句参数属于整台电脑，请到“语音服务”统一设置；TTS 模型、声线、语言、语速和发声说明归当前角色的": "この Route は、ホスト ASR サブスクリプション、ホット/ペルソナ キーワード ポリシー、および応答再生のみを所有します。 ASR モデル、マイク、VAD、およびセグメンテーションはホストに属し、Speech Service で構成されます。 TTS モデル、音声、言語、速度、およびスピーキング指示は現在のペルソナに属します",
    "主机只做一次 ASR，再把同一份文字广播给订阅 Route；不会为每个角色重复占用麦克风或重复跑识别模型。": "ホストは、ASRを一度実行し、同じテキストをサブスクライブしたRoutesにブロードキャストする。ペルソナごとにマイクのキャプチャや認識が重複することはありません。"
  }
} as const;
