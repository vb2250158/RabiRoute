# Rabi Link 设备探针合并说明

## 背景与目标

当前 `android-rabi-link-probe` 已从小米手环探针升级为 Rabi Link 设备探针，用来验证 Android 手机能从小米手环 10 Pro / 小米运动健康链路、Rokid 眼镜链路和后续设备链路读取多少信息。

新版手机 APK 的定位是“Rabi Link 设备探针”，用于集中验证手机 App 能通过系统权限、厂商 SDK、蓝牙链路、健康数据链路和眼镜链路拿到哪些信息，并把不同设备能力整理成统一的本地桥接模型。它不是 RabiRoute、Codex 或 MCP 的正式消息端接入层；这一阶段先做 Hello World 级别的能力验证、桥接抽象和证据采集。

当前小米链路仍按“证据探针，不是已完成产品能力”管理。BLE/公开 GATT、Health Connect 空结果、小米 Provider 权限边界和最近心率读取尝试可以保留；全天/历史心率列表还没有稳定普通 APK 后台 API。前台滑动图表、logcat 和截图路线只能证明数据在小米健康 UI 里存在，不能当作最终后台接口。

## 当前命名

手机端最终包名统一为：

```text
com.rabi.link
```

命名事实：

| 项目 | 当前命名 |
| --- | --- |
| 项目目录 | `android-rabi-link-probe` |
| 手机 APK 包名 | `com.rabi.link` |
| 手机源码路径 | `com/rabi/link` |
| Gradle root project | `RabiLinkProbe` |
| 通用 APK 输出名前缀 | `RabiLinkProbe` |
| 通用脚本/文件名前缀 | `RabiLinkProbe` / `rabi-link-probe` |
| App 显示名 | `Rabi Link 设备探针` |

命名应表达“这是一个多设备探针”，而不是让人误以为整个 APK 只服务小米手环。

本阶段只产出一个手机 APK，因此只有一个正式 Android 包名：`com.rabi.link`。源码里的 `modules/xiaomi`、`modules/rokid` 只是模块边界和 Java package 边界，不代表第二个 Android 应用包名。

## 模块化桥接模型

Rabi Link 应该是一个模块化单 APK，而不是把小米、Rokid 和未来设备逻辑写在同一个大 Activity 里。

模块化目标是“一个 APK 桥接所有手机侧可达能力”：小米、Rokid、Notepad 或后续设备都通过新增 `DeviceModule` 接入同一个 App Shell。首页和导出层只认识统一能力模型，不直接绑定厂商 SDK。除非用户另开新目标，否则不新增第二个 APK，也不新增 `com.rabi.link.*` 形式的正式应用包名。

核心结构：

- App Shell：负责接口测试中心、构建信息和统一导航；具体权限、日志、证据导出放到各模块测试页。
- Device Module：每类设备或厂商一个模块，例如 `XiaomiDeviceModule`、`RokidGlassModule`。
- Capability：模块对外暴露能力项，例如授权、连接、读取数据、录音、拍照、设备控制。
- Probe Result：所有模块统一输出结构化结果，包含状态、时间、摘要、错误、证据文件路径。
- Bridge Event：设备事件先转成统一事件，再由 UI、日志和导出层消费。

模块之间不直接互相调用。首页只认识统一的模块接口，不关心小米 SDK、Rokid SDK 或 BLE 细节。这样后续接入 Notepad、其他穿戴设备、眼镜、耳机或 Android 系统能力时，只需要新增模块，不需要重写主 APK。

建议的最小接口口径：

```text
DeviceModule
- id()
- displayName()
- summary()
- capabilities()
```

每个 `Capability` 至少描述：

```text
Capability
- id
- displayName
- category
- requiresUserAction
- requiresExternalApp
- description
```

当前代码已落地的模块边界：

- `bridge/DeviceModule.java`
- `bridge/Capability.java`
- `bridge/ProbeResult.java`
- `bridge/ProbeResultLog.java`
- `bridge/BridgeEvent.java`
- `bridge/DeviceModuleRegistry.java`
- `bridge/RabiLinkStorage.java`
- `modules/xiaomi/XiaomiDeviceModule.java`
- `modules/xiaomi/XiaomiBleProbeController.java`
- `modules/xiaomi/XiaomiBleScanResults.java`
- `modules/xiaomi/XiaomiBleGattProbe.java`
- `modules/xiaomi/XiaomiBleProfiles.java`
- `modules/xiaomi/XiaomiBleFormatter.java`
- `modules/xiaomi/MiHealthCloudContract.java`
- `modules/xiaomi/MiHealthOAuthForm.kt`
- `modules/xiaomi/MiHealthOAuthAuthorizationUrlBuilder.kt`
- `modules/xiaomi/MiHealthOAuthCallbackParser.kt`
- `modules/xiaomi/MiHealthOAuthSettingsStore.kt`
- `modules/xiaomi/MiHealthCloudProbeRequest.kt`
- `modules/xiaomi/MiHealthCloudArtifacts.java`
- `modules/xiaomi/MiHealthCloudProbeIntents.java`
- `modules/xiaomi/MiHealthCloudCallRunner.kt`
- `modules/xiaomi/MiHealthCloudSdkPageRunner.kt`
- `modules/xiaomi/MiHealthCloudRawHttpRecorder.kt`
- `modules/xiaomi/MiHealthCloudRawHttpFiles.kt`
- `modules/xiaomi/MiHealthCloudRawHttpSummary.kt`
- `modules/xiaomi/MiHealthCloudNotificationPresenter.kt`
- `modules/xiaomi/MiHealthCloudResultAccumulator.kt`
- `modules/xiaomi/MiHealthCloudResultStore.kt`
- `modules/xiaomi/MiHealthCloudMarkdownReportRenderer.kt`
- `modules/xiaomi/MiHealthCloudMarkdownStatsRenderer.kt`
- `modules/xiaomi/MiHealthCloudMarkdownFormat.kt`
- `modules/xiaomi/MiHealthCloudTimeFormatter.kt`
- `modules/xiaomi/MiHealthCloudZipExporter.java`
- `modules/xiaomi/MiHealthCloudResultActions.java`
- `modules/xiaomi/MiHealthCloudJsonSummaryAppender.java`
- `modules/xiaomi/MiHealthCloudDownloadExporter.java`
- `modules/xiaomi/MiHealthCloudShareSender.java`
- `modules/xiaomi/HealthConnectActivity.kt`
- `modules/xiaomi/HealthConnectForegroundHeartRateProbe.kt`
- `modules/xiaomi/HealthConnectHeartRateReader.kt`
- `modules/xiaomi/HealthConnectReadReceiver.kt`
- `modules/xiaomi/HealthConnectBackgroundProbe.kt`
- `modules/xiaomi/HealthConnectFormat.kt`
- `modules/xiaomi/HealthConnectResultStore.kt`
- `modules/rokid/RokidGlassModule.java`
- `modules/rokid/RokidProbeActivity.java`
- `modules/rokid/RokidAuthorizationFlow.java`
- `modules/rokid/RokidCxrController.java`
- `modules/rokid/RokidCxrCallbacks.java`
- `modules/rokid/RokidCxrLinkState.java`
- `modules/rokid/RokidProbeUi.java`
- `modules/rokid/RokidProbeEnvironment.java`
- `modules/rokid/RokidProbeText.java`
- `modules/rokid/RokidAudioCapture.java`
- `modules/rokid/RokidAudioStore.java`
- `modules/rokid/RokidPhotoStore.java`
- `modules/rokid/RokidProbeDefaults.java`
- `modules/rokid/RokidProbeReport.java`
- `modules/rokid/RokidReportClipboard.java`

首页是接口测试中心，只展示“小米接口测试”和“Rokid 眼镜接口测试”两张模块卡片。小米能力按钮进入 `XiaomiProbeActivity`，该页面映射现有 BLE、Health Connect、小米云和导出动作；Rokid 能力按钮进入 `RokidProbeActivity`，该页面已接入 CXR-L `client-l:1.0.4` 并提供手机侧能力探针入口。各模块执行结果会写入统一 `ProbeResultLog`。

Rokid 模块职责表：

| 文件 | 职责 |
| --- | --- |
| `RokidGlassModule` | 暴露 Rokid 模块和能力列表。 |
| `RokidProbeActivity` | 动作回调、Android 授权回跳和结果记录编排。 |
| `RokidProbeUi` | 页面布局和按钮列表。 |
| `RokidAuthorizationFlow` | Rokid 授权请求和回调解析。 |
| `RokidCxrController` | CXR-L 调用门面：连接、CustomView、音频、拍照和设备控制。 |
| `RokidCxrCallbacks` | 安装 CXR-L link、CustomView、audio、image 回调。 |
| `RokidCxrLinkState` | 保存 CXRLink 和眼镜蓝牙连接状态。 |
| `RokidAudioCapture` | PCM 音频缓冲和字节统计。 |
| `RokidAudioStore` | 音频 WAV 证据保存。 |
| `RokidPhotoStore` | JPEG 证据保存。 |
| `RokidProbeDefaults` | 探针默认参数：音频通道、拍照尺寸、JPEG 质量、亮度/音量和 Hello 文案。 |
| `RokidProbeEnvironment` | 环境诊断。 |
| `RokidProbeText` | CustomView payload、token 和设备信息文本格式化。 |
| `RokidProbeReport` | 页面报告和统一结果日志。 |
| `RokidReportClipboard` | 日志复制。 |

BLE 扫描生命周期和 GATT 连接由 `XiaomiBleProbeController` 归口，BLE 扫描结果缓存和设备列表映射由 `XiaomiBleScanResults` 承接，GATT 服务枚举、公开特征读取队列和心率通知订阅由 `XiaomiBleGattProbe` 承接，BLE 标准服务/特征 UUID 由 `XiaomiBleProfiles` 管理，广播、设备名/地址、心率字节和特征值格式化由 `XiaomiBleFormatter` 承接，`XiaomiProbeActivity` 渲染小米接口说明、按钮状态、设备列表和测试日志；Health Connect 前台授权、设置入口、复制结果和页面日志由 `HealthConnectActivity` 承接，前台最近 24 小时心率结果行渲染由 `HealthConnectForegroundHeartRateProbe` 归口，前台/后台共用心率读取和样本归一化由 `HealthConnectHeartRateReader` 归口，后台广播入口由 `HealthConnectReadReceiver` 承接，后台读心率/睡眠/步数由 `HealthConnectBackgroundProbe` 归口，Health Connect 时间/时长格式化和心率样本模型由 `HealthConnectFormat` 归口，后台心率 JSON 落盘由 `HealthConnectResultStore` 承接；下载目录、raw 目录和厂商证据子目录由 `RabiLinkStorage` 统一生成；小米云 prefs key、intent extra、文件名和 MIME 类型由 `MiHealthCloudContract` 统一生成；OAuth 页面按钮、授权回调和服务启动由 `MiHealthOAuthActivity` 编排，OAuth 表单控件和输入规范化由 `MiHealthOAuthForm` 承接，授权 URL 拼装和回调参数解析由 `MiHealthOAuthAuthorizationUrlBuilder` / `MiHealthOAuthCallbackParser` 承接，OAuth 配置、token 保存、状态文本和云拉取 Service Intent 由 `MiHealthOAuthSettingsStore` 归口；云拉取请求参数、默认值和全类型深扫列表由 `MiHealthCloudProbeRequest` 解释；最近一次结果和 raw 证据目录由 `MiHealthCloudArtifacts` 归口；云拉取 Intent/defaults 由 `MiHealthCloudProbeIntents` 归口；云拉取通知由 `MiHealthCloudNotificationPresenter` 生成；SDK/HTTP 超时调用由 `MiHealthCloudCallRunner` 归口；小米云 SDK 的 data source / dataset 分页由 `MiHealthCloudSdkPageRunner` 执行；raw HTTP 请求取证由 `MiHealthCloudRawHttpRecorder` 承接，raw 响应文件清理/落盘由 `MiHealthCloudRawHttpFiles` 归口，raw 响应 JSON 摘要由 `MiHealthCloudRawHttpSummary` 归口；本次探针的 source/page/error/point 缓冲和 SDK DataPoint 归一化由 `MiHealthCloudResultAccumulator` 管理；云结果 JSON/Markdown/log/自动 ZIP 落盘由 `MiHealthCloudResultStore` 承接；云结果 Markdown 报告结构由 `MiHealthCloudMarkdownReportRenderer` 归口，Markdown 摘要统计由 `MiHealthCloudMarkdownStatsRenderer` 归口，Markdown 点位值/转义/时间展示由 `MiHealthCloudMarkdownFormat` 归口；时间格式化由 `MiHealthCloudTimeFormatter` 统一处理；ZIP 证据包由 `MiHealthCloudZipExporter` 统一写出；最近结果按钮动作由 `MiHealthCloudResultActions` 编排，JSON 摘要解析由 `MiHealthCloudJsonSummaryAppender` 承接，下载目录写入由 `MiHealthCloudDownloadExporter` 承接，系统分享 Intent 由 `MiHealthCloudShareSender` 承接，避免 UI、通知和后台服务各自解释存储结构。

这一层只是 APK 内部抽象，不等同于 MCP，也不等同于 RabiRoute 的正式 route。后续如果要把 Rabi Link 作为 RabiRoute 消息端，可以在这个桥接模型之上再加一个外部适配层。

## 命名边界

命名清理时按能力归属划分，不做无意义的大改名。

保留小米专属命名的范围：

- 小米运动健康云 SDK、OAuth、Provider、Health Connect 相关实现。
- 明确只读取小米手环或小米健康数据的类、函数、按钮和日志。
- 可以继续使用 `Xiaomi`、`MiBand`、`MiHealth`。

Rokid 专属能力统一使用：

- `Rokid`
- `RokidGlass`
- `RokidCustomView`

通用能力统一使用：

- `DeviceProbe`
- `RabiLinkProbe`

通用命名适用范围：

- 首页入口。
- App 标题。
- 模块注册表。
- 统一能力列表。
- 桥接事件模型。
- 构建信息。
- APK 导出脚本。
- 日志和证据包总目录。
- 权限和运行状态汇总。
- 非厂商专属的分享、复制、保存、诊断功能。

需要重点清理的歧义名称包括旧目录名、旧手机包名、旧源码路径、旧 Gradle 工程名、旧 APK 输出名前缀、旧脚本文件名前缀和旧 App 显示名。

这些名称不应出现在通用入口、通用脚本、通用导出、通用日志或总 README 中；统一使用 `RabiLinkProbe` / `rabi-link-probe` / `Rabi Link 设备探针`。

## Rokid 能力清单

Rokid 眼镜探针优先验证官方 SDK 已开放的手机侧能力。每一项先做最小可用测试，再记录日志和证据文件。

### App 检测与授权

- 检查 Rokid AI App 或 Hi Rokid 是否安装。
- 检查版本是否满足 SDK 要求。
- 请求眼镜授权。
- token 不完整显示、不完整写入日志，只记录长度、摘要或前后少量字符。

### 连接与会话

- 使用 `CXRLink` 建立手机到眼镜链路。
- 分别显示 `CXRLink connected`、`Glass BT connected` 和 session ready 状态。
- 明确区分“链路就绪”和“CustomView 会话构建完成”。

### CustomView

- 打开一个 Hello World 级别的眼镜端自定义 View。
- 更新文本内容。
- 关闭 View。
- 记录打开、更新、关闭、错误回调。

### 音频流

- 启动短时音频流测试，默认 5 秒。
- 统计收到的 PCM 字节数。
- 按 Rokid 文档的 16 kHz、mono、16-bit PCM 口径保存 WAV。
- 记录开始、停止、错误和最终文件路径。

### 拍照

- 调用拍照接口，默认参数为 `1024 x 768`、质量 `80`。
- 保存 JPEG。
- 记录回调状态、字节数和文件路径。

### 设备控制与设备信息

- 读取眼镜设备信息。
- 显示亮度、音量、电量、设备名、佩戴状态等字段。
- 提供显式按钮测试亮度和音量设置。
- 每次设置后再次读取设备信息，方便确认是否生效。

### CustomApp 可行性记录

CustomApp 如果被官方 SDK 明确要求眼镜侧应用配合，则不放进当前主线实现。当前统一 APK 只桥接手机侧 SDK 已开放能力；需要独立眼镜端应用的部分只记录可行性和接口证据，避免把“单 APK 探针”变成双安装包方案。

## APK 结构

手机端继续使用现有 `app` 模块作为唯一 APK 主入口。小米能力和 Rokid 能力都从这个手机 APK 进入。

本阶段不新增眼镜侧 APK，不内置眼镜端 APK，也不定义第二个 Android 应用包名。Rokid 侧优先验证手机侧 SDK 已开放的能力：授权、连接、CustomView、音频流、拍照、设备信息和设备控制。

APK 内部按模块组织：

- `app shell`：通用入口和结果展示。
- `xiaomi` 模块代码区：迁移现有小米手环 / 小米运动健康探针。
- `rokid` 模块代码区：新增 Rokid 眼镜手机侧探针。
- `bridge` 通用代码区：统一模块接口、能力模型、事件模型和结果模型。
- `export` 通用代码区：统一保存 Markdown、JSON、WAV、JPEG 和 ZIP 证据包。

这些是代码组织边界，不代表多个 APK，也不代表多个 Android package。最终安装到手机上的仍然只有 `com.rabi.link`。

## 实施顺序

1. 新增本说明文档，先锁定目标和命名口径。
2. 做命名迁移：
   - 改包名。
   - 改源码路径。
   - 改项目目录名。
   - 改通用文件名、脚本名、APK 输出名。
   - 保留小米专属命名。
3. 抽出单 APK 内部模块化桥接层：
   - 建立统一 `DeviceModule` / `Capability` / `ProbeResult` / `BridgeEvent` 口径。
   - 把现有小米入口包装成 `XiaomiDeviceModule`。
   - 首页只展示模块测试卡片，具体按钮进入模块测试页。
4. 接入 Rokid 手机侧 SDK：
   - 添加 Maven 仓库。
   - 添加 CXR-L 依赖。
   - 将手机 App `minSdk` 提到 `31`。
   - 新增 `RokidGlassModule`。
   - 把授权、连接、CustomView、音频、拍照、设备控制注册成能力项。
   - 新增 `RokidProbeActivity` 执行真实 CXR-L 调用。
5. 补齐构建导出：
   - 构建手机 APK。
   - 输出文件统一使用 `rabi-link-probe` 命名。
6. 做本机编译和真机验证。

## 验收清单

命名验收：

- 手机 APK 包名为 `com.rabi.link`。
- 只有一个 APK 安装到手机。
- 通用目录、脚本、APK 输出名、日志总目录不再使用旧手环探针前缀。
- `Xiaomi` / `MiBand` / `MiHealth` 只出现在小米专属上下文。
- `Rokid` / `RokidGlass` 只出现在 Rokid 专属上下文。

模块化验收：

- 首页展示小米和 Rokid 两张接口测试卡片。
- 小米能力通过 `XiaomiDeviceModule` 暴露，并复用现有小米探针动作。
- Rokid 能力通过 `RokidGlassModule` 暴露，并进入 `RokidProbeActivity` 执行手机侧 SDK 探针。
- 后续每个能力执行后都应产出统一 `ProbeResult`。
- 日志和证据导出层不依赖具体厂商 SDK 类型。

小米能力验收：

- 首页仍能进入小米手环 / 小米运动健康接口测试页。
- 原有 OAuth、云拉取、Health Connect、BLE、Provider 相关能力能继续编译并打开。

Rokid 无设备环境验收：

- 未安装 Rokid AI App / Hi Rokid 时，页面给出明确诊断。
- 未授权、未连接或未配对眼镜时，不崩溃。
- 每个按钮失败时都记录可读错误。

Rokid 真机环境验收：

- 授权成功。
- `CXRLink` 和眼镜蓝牙连接状态能显示。
- CustomView 能打开、更新、关闭。
- 音频流能生成 WAV。
- 拍照能生成 JPEG。
- 设备信息能读取。
- 亮度和音量设置有返回。

## 非目标

这一阶段不做以下事情：

- 不新增第二个 APK 或第二个 Android 包名。
- 不接入 RabiRoute 正式路由。
- 不接入 Codex 消息端。
- 不把 Rokid 当作 MCP host 或 MCP client。
- 不实现 Rokid CustomApp 眼镜侧应用。
- 不实现长期运行的语音助手。
- 不实现自动外发消息。
- 不上传或发布任何运行数据。

## 文档维护规则

本文件是后续实现的依据。实施过程中如果发现 Rokid SDK 实际 API 名称、权限名或版本号和当前记录不一致，应先更新本文档，再改代码。

README 可以在功能完成后再同步更新；在命名迁移和 Rokid 接入完成前，不建议把现有小米探针 README 直接改成总文档，避免历史测试流程和新设备探针目标混在一起。
