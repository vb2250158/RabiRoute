简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.speech

内置 Manager 插件。实例 `manager:speech` 提供 `manager.speech@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

本插件注册 39 个可执行接口：32 个类型化操作和 7 个精确 HTTP 代理。接口目录、参数解析和执行定义共用同一份合同；普通 JSON 由公共注册器解析一次，原服务继续校验业务值。每条合同从自身方法和路径派生兼容别名 `speech:METHOD:PATH`，不再维护另一张接口表。

## 公开入口

以下路径均相对于 `/api/speech`。类型化操作的 ID 为 `manager.speech.` 加表中名称；同一行多个名称按方法顺序对应。

| 方法 | 路径 | 操作名称 |
| --- | --- | --- |
| GET | `/events` | `events`，保留原始 SSE 字节 |
| GET | `/status` | `status` |
| GET、PUT | `/selection-reader/settings` | `selection-reader.read`、`selection-reader.write` |
| GET | `/models` | `models` |
| GET | `/personas` | `personas` |
| GET、POST | `/speakers` | `speakers.list`、`speakers.create` |
| PATCH、DELETE | `/speakers/:speakerId` | `speakers.update`、`speakers.delete` |
| PUT、DELETE | `/speaker-bindings` | `speaker-bindings.write`、`speaker-bindings.delete` |
| PUT | `/speaker-identities` | `speaker-identities.write` |
| GET | `/playback/status` | `playback.status` |
| GET | `/audio-streams` | `audio-streams.status` |
| GET | `/audio-streams/events` | `audio-streams.events` |
| POST | `/audio-streams/token` | `audio-streams.token` |
| PUT | `/audio-streams/selection` | `audio-streams.selection` |
| PUT | `/playback/volume` | `playback.volume` |
| GET | `/records` | `records.list` |
| GET | `/records/:recordId/audio` | `records.audio`，原始有限字节响应 |
| GET | `/microphone/status` | `microphone.status` |
| PUT | `/microphone/settings` | `microphone.settings` |
| POST | `/microphone/reconcile` | `microphone.reconcile` |
| GET | `/microphone/devices` | `microphone.devices` |
| POST | `/microphone/start`、`/microphone/stop` | `microphone.start`、`microphone.stop` |
| POST | `/playback/stop` | `playback.stop` |
| POST | `/tts`、`/asr` | `tts`、`asr`，原始有限字节响应 |
| GET、POST | `/messages` | `messages.list`、`messages.accept` |

以下 7 个接口分别注册精确代理合同，同样使用 `manager.speech.` 名称前缀：

| 方法 | 路径 | 操作名称 |
| --- | --- | --- |
| POST | `/runtime/start`、`/runtime/stop` | `runtime.start`、`runtime.stop` |
| GET | `/model-management` | `model-management.read` |
| POST | `/model-management/runtime/install` | `model-management.runtime.install` |
| POST | `/model-management/models/:modelId/install` | `model-management.models.install` |
| GET、PATCH | `/model-management/settings` | `model-management.settings.read`、`model-management.settings.write` |

本范围没有静态资源或 WebSocket 入口；`/audio-streams/token` 仍由原服务提供 token。

## 执行与资源归属

`SpeechApiOwner` 调用原 `ManagerSpeechControl`、`SpeechRuntimeControl`、`SpeechModelManager`、划词设置和语音消息存储。模型、音色、ASR、TTS、麦克风、播放队列、安装任务和消息来源仍由原服务拥有。消息提交继续由主机填写来源身份。鉴权成功的远端连接默认可调用这些公开能力，仅保留原有用户禁用项、参数和资源约束。

接收请求时固定原连接身份、选中的远端服务和计算设备。等待完成、外发前及返回数据前重新核对；原连接失效或目标改变时停止本次请求。`GET /models` 与 `POST /tts` 保留 `computeDeviceId` 查询参数。精确代理把原方法、路径、请求头和正文交给已选远端；远端失败不会转为本机启动、安装或修改。

普通 JSON 保留原来的空正文、内容类型和大小行为，公共注册器只解析一次，再调用原业务校验。ASR 保留原 multipart 正文和边界，最多 27 MiB，由原转录服务校验内容类型。三个有限字节接口保留原状态、具体内容类型、音频字节与元数据头，缓冲上限沿用 Node Buffer 原有上限。SSE 保留注释、`id`、`retry`、多行数据及非 JSON 内容，不重新分帧。

模型目录设置 PATCH 属于原始 HTTP 代理：远端正文由原隧道和目标 Manager 消费；仅本机分支使用原 Manager JSON 解码器。该分支保留只读检查、`application/json`、预期 generation/Manager 请求头和原始 CAS 写入，正文只能是 `{modelRoot, expectedRevision}`。`expectedRevision` 必须是非负安全整数；目录仍由原存储检查固定本地磁盘和受保护路径，并通过文件锁比较修订号。GET 与 PATCH 保留 `no-store`。

## 生命周期与验证范围

候选阶段只登记操作和代理，不修改 `managerServicesReady` 或当前语音协调回调，也不启动或停止共享语音服务。插件使用公共 `context.publication.add` 生命周期：`publish` 只同步切换当前协调回调，`rollback` 恢复原回调；`afterPublish` 等待原 activation 退役后才协调语音服务。发布前失败的候选只清理自己的登记和 SSE 资源，原接口继续可用。

退役先停止两个注册器接收新请求，取消并等待原 SSE 生产者和已接收操作，包括客户端已断开但仍在执行的工作。替换或回滚版本时，新 activation 接管同一组原服务；旧 activation 不停止共享麦克风、播放、模型或安装器。只有仍拥有当前协调回调的 activation 退役时才停止这些服务，并在原请求排空后再次核对归属。清理超时后仍在执行的原关闭任务必须先完成，后续候选才能接管。安装器清理继续等待原子进程真正触发 `close`、关闭标准输出与错误流；一个清理动作失败时仍等待其余清理完成，再报告错误。

HTTP 202 表示安装任务已接收；播放任务或 HTTP 成功不证明已播放、已转录投递或完成真实设备操作。写入结果不确定时先查原服务状态和原任务 ID，不自动重放。

源码回归覆盖全部 39 个入口、受控 HTTP 的原生 TTS/ASR、远端原始代理、连接身份撤销、计算目标变化、候选失败恢复、成功替换与回滚、断线后的原工作和 SSE 清理等待，以及安装器关闭。运行验收范围以实际测试报告为准；安装版、真实模型、扬声器和麦克风另行验收。
