[English](desktop-pet-bubbles_en.md) | 简体中文

# 桌宠气泡与语音

开启“显示气泡”后，投递到该人格面板并已保存的 Agent 消息会在对应桌宠上显示原文。只接收连接期间的新消息，不补弹历史；用户输入、草稿、失败投递和其他人格消息不显示。同一消息 ID 去重，连续消息按顺序显示，等待队列最多保留最近 32 条；语音播放期间延后，关闭气泡、隐藏或静音时不接收展示。这里只显示文字，不额外触发语音合成。

单击松手后立即播放回应动作，再次单击会从头重播。双击仍打开角色面板，第二次松手不再重复回应。按住后移动超过系统拖拽阈值才开始拖动；轻微手抖保持单击，只有实际拖动才保存位置。回应结束后恢复正在播放的语音或陪伴动作；随机待机和睡眠被菜单、按住或互动暂时挡住后会继续调度。

右键菜单的“大小”显示当前百分比，展开后直接拖动滑条，在 10%–200% 之间以 1% 精度调整。拖动时复用已加载画面即时缩放预览，动画继续播放；松手或收起大小子菜单不会重建动画。关闭整个右键菜单后，才按最终大小重建一次并自动保存；调回原大小则无需重建或保存。重新打开菜单或重启会恢复已保存的大小。

桌宠右键勾选“显示气泡”。陪伴评论、任务结果和本机角色语音共用普通对话气泡。进入 RabiSpeech 主机播放队列且 `voice` 等于桌宠角色 ID 的语音开始播放时，气泡显示对应文字，桌宠播放说话动作；播放结束后默认保留 8 秒。普通提示不会覆盖正在说话的文字。

气泡只显示文字。长文字可滚动，最多显示 4000 字；窗口不抢焦点。点透开启时气泡也点透。隐藏桌宠或关闭气泡只影响显示，声音仍由语音队列控制。

右键“气泡样式…”可预览并保存猫爪或纯色外观、系统字体、字号（12–24 px）、文字颜色、宽度（220–480 px）、不透明度（50–100%）和停留时间（2–30 秒）；纯色外观还可修改背景和描边。角色面板的桌宠设置提供相同配置。每个角色单独保存，重启后恢复。猫爪框体通过九宫格绘制，右下角纹理保持固定大小；尖角独立绘制并对准桌宠可见轮廓的横向中心。框体靠近屏幕边缘时自动限位，尖角继续跟随；上方空间不足时气泡移到桌宠下方，尖角朝上。正文与纹理之间留有空白。

桌面订阅 Manager 的 `/api/speech/events` 并读取 `/api/speech/playback/status` 恢复正在播放的一句；重连不弹出旧历史，也不自动重播。Qt 只展示，合成、播放、音频缓存和队列状态仍由 RabiSpeech 拥有。

## 角色台词

陪伴开场与本机提示只读取当前角色目录的 `desktop-pet/dialogue.json`，不从动作包、其他角色或共享缓存借用台词。没有有效配置、文件损坏或连接失败时使用中性提示。示例：

```json
{
  "schemaVersion": 1,
  "personaId": "sample-persona",
  "openers": {
    "watch": "一起看吧。",
    "play": "我陪你玩。",
    "work": "一起努力。"
  },
  "fallbacks": {
    "companionInterrupted": "稍等，正在恢复连接。",
    "managerInterrupted": "暂时连不上服务。"
  }
}
```

`personaId` 必须与目录角色 ID 一致，`schemaVersion` 为 `1`，文件上限 64 KiB；每条非空字符串最多读取 1000 字。`fallbacks` 还支持 `companionFailed`、`actionUnavailable`、`bubbleStyleSaved`、`bubbleStyleFailed`，分别用于陪伴操作失败、动作不可用和气泡样式保存结果。只缺某项时仅该项回退。桌宠创建、Manager 重连或该角色桌宠设置变化时重新读取；直接编辑文件后可保存一次该角色桌宠设置触发刷新。

## 文字记录（维护者）

Manager 在角色目录的 `desktop-pet/transcripts/<tts|asr>/<hash前两位>/<hash>.json` 保存逐条文字记录。TTS 来自该桌宠接收到的、`voice` 精确匹配角色 ID 的主机正在播放事件；初次重连可记录当前一句，不追补已结束的历史。隐藏气泡不影响记录。ASR 来自已选择该本机角色的消息路线，保留规范化的说话人文字；未归属语音与远端角色不写入本机桌宠目录。原始 ASR 详情仍在 `voice-transcripts.jsonl` 和原有聊天记录中，语音合成、播放证据仍由 RabiSpeech 拥有。

这些文件是按角色组织的文字副本，不是第二套消息投递队列。`schemaVersion=1`，字段为 `personaId`、`kind`、原始 `id`、`source`、`text`、Unix 秒 `time`；按 `time` 和 `id` 排序。文件键由 `kind + source + id` 的 SHA-256 决定，单条文件可直接定位，使用现有文件锁与原子写入；重试返回已存在，不追加重复文字，同键不同内容拒绝覆盖。没有全量扫描索引。原记录保留，不自动归档、沉淀或删除；这里是逐记录存储，不应用 24/72 小时归档窗口。Qt 单次写入超时 5 秒，失败间隔 3 秒最多尝试三次，最终失败写诊断日志；断电、关闭或超出重试期间的未确认文字没有跨重启补录保证。

### Manager 接口

沿用现有 Manager 连接鉴权，不添加逐接口许可；地址由当前 Host/READY 发布。以下 `{baseUrl}` 为已核对 `/meta` 身份的完整地址，`{personaId}` 为 URL 编码后的角色 ID。

- `GET {baseUrl}/api/desktop-pet/roles/{personaId}/dialogue`：返回 `{ "code": 0, "data": { "personaId": "sample-persona", "dialogue": { "openers": {}, "fallbacks": {} } } }`；对象内只包含该角色的有效字符串，客户端逐项使用中性缺省。
- `POST {baseUrl}/api/desktop-pet/roles/{personaId}/transcripts`：`Content-Type: application/json`，请求 `{ "personaId": "sample-persona", "voice": "sample-persona", "kind": "tts", "id": "playback-job-id", "text": "你好。", "time": 1710000000 }`，响应 `{ "code": 0, "data": { "personaId": "sample-persona", "appended": true } }`。重复写入的 `appended=false` 是已保存回执；ASR 由内部路由记录，不接受客户端伪报为 ASR。请求上限 64 KiB；不保存音频和任意附加字段。
- 非法 ID、角色不匹配、无效文字/时间、冲突内容或读取/保存失败返回 `400`、`code=-1` 与 `message`，不确认保存；错误方法返回 `405`。写入超时后用完全相同的 ID 与载荷重试，不换 ID；文件是持久回读证据，没有独立回执查询接口。

设置保存在 Manager 的角色桌宠绑定 `bubbleStyle` 中，通过原有 `/api/desktop-pet/roles/{personaId}` 更新，桌面不直接写配置。底图位于桌面运行包的 `rabiroute_tray/assets/bubble-cat-paw-body-v2.png`；九宫格切分比例与固定绘制尺寸见同目录资源说明。浏览器自行播放的音频、远端设备播放和未匹配角色的系统音色不附着到本机桌宠。
