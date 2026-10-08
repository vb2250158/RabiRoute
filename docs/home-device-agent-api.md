<div align="center"><a href="home-device-agent-api_en.md">English</a> | 简体中文</div>

# 家庭设备与音箱 Agent 接口

> 状态：实验集成，拥有自动化合同测试。每种真实设备和服务仍需在使用者环境验收。Manager 的米家插件统一持有客户端、策略设置、凭据和持久动作回执；Agent 不直接读取令牌或调用 Home Assistant 服务。

先按 [Agent 接口指南](rabi-agent-interfaces.md)发现当前 Manager URL，核对 `/meta` 的 generation、instance 和健康状态。以下路径相对于该地址，复用已有连接鉴权；本机 Agent、已鉴权 WebGUI 和已登记远端 Agent 使用同一业务合同。安装部署操作仍在本机执行。

## 发现与调用

`GET /api/agent/xiaomi-home/health` 单独报告 HA 连接、事件监听和录像状态；Manager 就绪不等于 HA 连接成功，也不等于所有设备在线。连接成功后即可使用设备支持的动作。

1. `GET /api/agent/help` 可发现以下业务接口。`GET /api/agent/xiaomi-home/capabilities` 返回 `schemaVersion=1`、动作及 `argumentsSchema`、当前播报绑定和确认方式。这是动作参数目录，无需再次申请功能许可。
2. `GET /api/agent/xiaomi-home/resources` 列出全部已接入实体、状态、`available`、`capabilities`、`stateVersion`。实体不是物理设备数量：一台扫地机可以有多个传感器、按钮和设置。使用 `?includeActions=1` 一次发现所有实体的实时动作；单项 `GET /api/agent/xiaomi-home/entity-actions?resourceId=<URL 编码 resourceId>` 返回同一资源和 `actions`。普通单项状态仍通过 `/resources/<URL 编码 resourceId>` 读取。
3. 向 `POST /api/agent/xiaomi-home/action-requests` 提交下例。必须携带稳定 `Idempotency-Key`，以及从当前 `/meta` 取得的 `x-rabiroute-expected-application-generation-id`、`x-rabiroute-expected-manager-instance-id`。接口不接受任意 HA 服务名或额外字段。

```json
{
  "requestId": "speaker-demo-001",
  "resourceId": "home:ha:media_player.example_speaker",
  "capability": "home.speaker.speak@1",
  "arguments": {"text": "智能家居播报测试。"},
  "expectedStateVersion": "从刚刚读取的资源取得",
  "reason": "用户请求播报",
  "dryRun": true
}
```

`requestId` 可省略或使用 1–128 位字母、数字、`.`、`_`、`:`、`-`；它用于关联，不代替幂等键。`Idempotency-Key` 使用同一字符集合，1–160 位。`reason` 可省略，最长 500 字符，不接受控制字符。`dryRun` 必须为布尔值；只有预演不发送设备服务。需要预演时使用 `dryRun=true`，正式执行使用新的独立动作键提交 `dryRun=false`，不能改变同一幂等键的正文。

4. 无论客户端超时、切代或返回 uncertain，都先用 `GET /api/agent/xiaomi-home/action-requests?idempotencyKey=<URL 编码原键>` 查询。返回 `state=completed|in_progress|uncertain`、时间及已有 `receipt`；404 表示该键没有可读取回执，不证明外部设备一定没执行。查询不发送动作、不读 HA 凭据、不需要 HA 在线。

## 动作范围

### 所有已接入设备的动作

`home.entity.action@1` 复用同一 POST、状态版本、生命周期身份和幂等回执，不需要逐设备许可、控制开关或额外密钥。它从当前 HA 服务目录、实体 feature、参数过滤、数值范围和可选值派生动作，不按设备名称维护白名单。按钮、数字、下拉选项、文本、通知动作、灯、风扇、空调、媒体播放器和其他已有实体域均使用此入口。仅有读数且上游没有动作的传感器仍可查询；不能把缺少控制协议称为权限问题。

先读取目标的 `actions`，选取一个动作的 `action`、`revision` 和 `argumentsSchema`。把参数按该 Schema 放入 `parameters`，并将 `revision` 填入 `actionRevision`：

```json
{
  "resourceId": "home:ha:number.example_volume",
  "capability": "home.entity.action@1",
  "arguments": {"action": "set_value", "actionRevision": "从动作目录读取", "parameters": {"value": 20}},
  "expectedStateVersion": "从同一次资源查询读取",
  "reason": "用户要求调整音量",
  "dryRun": true
}
```

执行前重新读取服务与目标，验证动作仍存在、参数 Schema revision 一致、数值范围和选项符合当前实体。上游未能完整翻译的 selector 保留在 `providerSelector`，只接受有界 JSON，由 HA 验证该 selector 的细节；发现结果不等于每个物理动作都已验收。目标由 `resourceId` 唯一确定，参数不能重定向 `entity_id`、`device_id`、`area_id` 或 `target`。不带实体目标的全局服务不属于设备动作。`unknown` 表示读数尚未知或动作未调用，与离线不同；已公布的通用实体动作仍可调用以初始化设置。`unavailable` 仍拒绝。

小米通知实体的 `action params` 是有序参数，而不是普通通知正文。目录把其类型转为 `parameters.values` 数组，顺序、数量、整数、字符串和布尔值均验证，再由 Manager 编为 JSON 数组交给官方集成。例如单字符串动作使用 `{"values":["实际参数"]}`；遥控整数参数使用 `{"values":[实际按键值]}`。不得猜按键编号、房间 ID 或字符串内部协议；房间与划区字符串须按设备实际协议构造，HA 房间名不等于扫地机地图房间 ID。读取 live 房间信息实体可以获取已公开的地图房间资料。

此通用入口返回 `accepted/provider_acceptance`，证明 HA 受理，不证明移动完成、清扫完成或声音已播放。可再查询状态、传感器与回执；中断或响应丢失不重发。原有简化动作仍可使用下表，其状态读回语义不变。

### 扫地机和音视频边界

Manager 另提供[实验性米家云地图文件连接](vacuum-cloud-map.md)，在米家 Setup 打开扫码页。登录和云凭据由连接组件保存，已鉴权 Agent 共用只读设备与文件接口；支持 version-2 地图和文件中的位置快照，时效未验证；只读 position 接口还可核对设备位置属性，空值保持不可用，坐标单位与时效未验证。仍不提供坐标导航或机器人音频。

扫地机的开始、暂停、停止、回基站、定位，以及额外的遥控、房间／划区清扫等，是否出现取决于该设备的实体与服务。位置传感器可能为空；“定点清洁”不能冒充“移动到坐标并停住”。语音包下载、提示音开关不等于任意文字播报，视频开关不等于可读音频／视频流。官方 Xiaomi Home 集成[不提供扫地机地图解密、摄像头视频流和音箱对话历史](https://github.com/XiaoMi/ha_xiaomi_home/wiki/Features-that-will-not-be-implemented)；不能据此声称已接通坐标导航、收音或双向通话。其它集成提供可用媒体流时，需通过相应媒体合同接入。

能力目录包含现有灯、开关、风扇、窗帘、温控与扫地机的 15 个简化动作，以及以下媒体动作。参数均按目录校验，不接受字符串代替数字、字符串代替布尔值或未声明字段。

| 能力 | 参数 | 开放条件 / 确认 |
| --- | --- | --- |
| `home.speaker.speak@1` | `text`，非空，最长 1000 字符 | 显式播报绑定；服务受理 |
| `home.media.play@1` / `pause@1` / `stop@1` | 无 | 对应 HA feature；状态读回 |
| `home.media.next_track@1` / `previous_track@1` | 无 | 对应 feature；服务受理 |
| `home.media.set_volume@1` | `volume`，0–1 | 对应 feature；音量读回，容差 0.02 |
| `home.media.mute@1` | `muted`，布尔值 | 对应 feature；静音状态读回 |
| `home.media.seek@1` | `positionSeconds`，0–86400 | 对应 feature；服务受理 |
| `home.media.select_source@1` / `select_sound_mode@1` | `source` / `soundMode` | 当前资源公布的选项；状态读回 |
| `home.media.play_media@1` | `url`、`mediaType` | 对应 PLAY_MEDIA feature；服务受理 |

媒体 URL 最长 2048 字符，只接受 HTTP(S)，禁止用户凭据、query 与 fragment；媒体类型只接受 `music`、`url` 或 `audio/*`。URL 交给 HA/设备，Rabi 不下载或中转媒体，也不把本机文件路径伪装成设备可播放 URL。地址必须能被目标播放器访问。设备没有 PLAY_MEDIA 时，不提供 URL 播放；支持文字播报不表示支持播放任意音频文件。

## 播报绑定

在当前 Route 的“米家 / Xiaomi Home → 设置 → 音箱播报”选择音箱和同一设备的“播放文本”通知服务，再保存。设置由本机 `settings.json` 唯一持有，已鉴权连接也可通过 `GET/PUT /api/agent/xiaomi-home/settings` 使用完整 settings、revision 和 lifecycle fence 更新。`speechBindings` 默认空、最多 64 项，音箱与通知实体都不能重复：

```json
{"mediaPlayerEntityId":"media_player.example_speaker","notifyEntityId":"notify.example_speaker_text","encoding":"json-array"}
```

`json-array` 为单个字符串生成 JSON 数组，避免上游 YAML 把“yes”等文本转换为布尔值；调用前要求通知服务公布恰好一个字符串参数。`text` 仅适用于普通文本通知，带 `action params` 的结构化服务不能使用该格式。通知初始状态 `unknown` 不阻止已绑定播报；`unavailable` 拒绝执行。未绑定通知和“执行文本指令”等入口可在实时目录公布时使用通用实体动作合同。绑定是操作者确认用途与设备归属的配置，不是根据实体名称推断的权限。

## 回执与失败

POST 正常返回 HTTP 202、`code=0` 与动作回执。`planned` 是未执行，`accepted` 只证明服务受理（`confirmation=provider_acceptance`），`succeeded` 只证明读回目标状态（`state_readback`），`failed` 是明确拒绝，`uncertain` 是结果不能确认。播报、切歌、定位和媒体播放不会因播放器显示 playing 或通知时间戳变化而宣称“声音已经播放”；是否听到仍需真实设备或用户证据。

400 为请求格式错误；403 为禁止的能力/绑定或来源；409 为幂等冲突、执行中或不确定；412 为最新状态已变；404 为资源/回执不存在；503 为服务/回执存储不可用。设备能力消失、离线、选项或播报参数变化会生成 `failed` 回执且不发送服务。明确 HA 4xx 拒绝保留失败回执；5xx、断线或丢失 POST 响应只读恢复，不自动重发。

完整 intent（包括 HA origin、绑定后的目标服务、参数、状态版本、预演和原因）绑定持久键；并发、客户端重建和 Host 重启复用同一回执。只读查询保留旧回执，但新增 origin 摘要合同与旧摘要不相同，旧键重提返回冲突，不迁移为新执行。已知安全的状态版本 CAS 拒绝没有发送动作，可读取新状态后重用原键修正版本。其它 failed 不自动重试；修复后的新动作需用户授权和独立键。系统不提供取消已下发服务、声学完成回调或批量回滚。

回执存储和 API 不包含播报正文、媒体 URL、Home Assistant token 或本机文件路径；仅保留请求摘要、目标、能力、时间、状态版本和确认方式。公网示例必须使用占位实体，本机真实设备绑定保留在私有运行数据中。停止服务不会撤回已下发动作。


## 设备目录与界面

GET `/api/agent/xiaomi-home/devices` 不接受参数，返回 schemaVersion=1、observedAt、devices 和 unassignedResources。devices 以 HA device registry ID 归组已有 resources，包含 deviceId、displayName、model、manufacturer、areaName 和 resources；同名设备不合并，无归属实体不伪装为物理设备。组件使用固定只读模板读取登记元数据，不开放模板执行入口，也不返回设备标识全集或凭据。单项动作和参数仍从 entity-actions 实时发现，未新增动作写入者。WebGUI 的[设备列表](user-guide/home-devices.md)复用同一动作接口、版本和幂等回执；最近浏览器回执仅用于恢复查询。


## 手动遥控（WebGUI 与 Agent 共用）

地图下方点击“进入手动控制”。正在清扫时，服务先调用 HA 的 pause 并读回 paused，再进入遥控并等待初始化；暂停未确认时不发送方向。官方 pv11cn 第61版遥控页只调用 ENTER_REMOTE，不能据此保证所有固件自动暂停。退出不自动恢复清扫，设备退出遥控后的自动回仓行为仍需实机确认。

控制面板获得焦点后，按住 W 前进、A 左转、D 右转；S 停止，当前协议没有倒退指令。松键、焦点移出和窗口失焦均发送松键。触屏可按住方向按钮。隐藏页面、关闭详情或切换页签会退出遥控。视频可能有延迟，请同时观察机器人；动作受理不等于物理停止。

公共路径为 `/api/agent/xiaomi-home/vacuum-remote`。GET `/capabilities?resourceId=...` 返回实时资源 stateVersion、protocolRevision 与方向；POST `/start` 接受 `{resourceId,expectedStateVersion,protocolRevision}`，返回会话。POST `/pulse` 接受 `{sessionId,expectedStateVersion,direction,durationMs}`，方向为 forward/left/right，单次100–500毫秒。已核对型号在短按期间每200毫秒续发方向，capabilities 公布 repeatIntervalMs；发送串行且共用绝对截止时间，慢响应不延长脉冲、不补发过期时隙，服务在 finally 松键；不接受倒退、任意码或坐标。POST `/stop` 接受 `{sessionId}`，只松键并保留遥控模式；POST `/exit` 接受 `{sessionId}`，松键后退出模式。GET `/status` 选择 sessionId 查询会话或 idempotencyKey 查询原回执。所有写入沿用当前 generation/instance 围栏和稳定幂等键；超时只查原键，不换键重发。每个结果有独立 stateVersion，下一次 pulse 使用读回的新值。

Manager 的 VacuumRemoteController 是遥控会话唯一拥有者，一次只保留一个控制会话并串行方向脉冲；WebGUI、Codex、DSH 共用该接口和 HA 动作回执链，不持有 HA 凭据。初始化、停止和退出互相协调，退出后不会由晚到的初始化响应恢复遥控。重启只保留历史回执，不重放运动。坐标导航仍未接通。

运维者在米家组件运行目录设置 `vacuum-remote-bindings.json`：

```json
{"schemaVersion":1,"bindings":[{"resourceId":"home:ha:vacuum.example","watchdogResourceId":"home:ha:timer.example_remote_release"}]}
```

此绑定指定设备的独立 HA 松键计时器，不是额外权限。计时器必须配置为7秒、restore=true；HA 的 timer.finished 和启动自动化需调用已核对的该型号松键码2/4/6及 EXIT_REMOTE。每次初始化和方向前重设7秒计时器，松键确认后取消；松键失败保留计时器。未核对型号、实体、动作目录或没有独立计时器时明确报告不可用。旧逐步移动脚本不再作为新的遥控入口；保留 HA 独立停止脚本仅供计时器和启动补偿，迁移后的调用者应使用 start/pulse/stop/exit。
