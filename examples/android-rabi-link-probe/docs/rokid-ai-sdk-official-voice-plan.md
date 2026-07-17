# RokidAiSdk 正式语音路线

<!-- docs-language-switch -->
<div align="center">
<a href="./rokid-ai-sdk-official-voice-plan_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

> 状态：实验实施与取证记录。眼镜端 SDK 资产、32 位 ABI 和安全门已验证；正式凭证与真实 ASR/TTS 服务闭环仍未完成。

本文记录 `com.rabi.link` 继续接入 Rokid 原生 ASR/TTS 时，除 CXR-L CustomApp 之外的正式 SDK 路线。目标是确认“用户说了什么”能否以文本形式返回，以及 TTS 能否由 APK 直接触发播报。

## 当前结论

| 状态 | 项目 | 结论 |
| --- | --- | --- |
| 已验证 | CXR-L CustomApp / CustomCmd | 可以安装并启动眼镜端测试 APK，可以画 GUI，可以双向传 `RABI_*` 文本命令。 |
| 已验证为当前不可用 | Glass3 SDK ASR/TTS | 眼镜端测试 APK 回 `serverPackage=false;serviceConnected=false`，CustomApp 环境里看不到 `com.rokid.security.system.server`，因此 `GlassSdk` ASR/TTS 不能直接 ready。 |
| 已验证为当前不可用 | Glass3 SDK 离线语音指令 | 已接入 `GlassOfflineCmdService` 探针和 `offline_cmd_arm` / `offline_cmd_clear` 命令；真机状态为 `offlineCmd=false`，注册离线指令返回 `RABI_OFFLINE_CMD_ERR:glass_sdk_not_ready`。这说明固定词条也依赖 Glass SDK Security Service，不能绕过当前 CustomApp 服务缺口。 |
| 已验证为当前不可用 | 眼镜端 Android 系统 ASR/TTS | 已在眼镜 APK 内直接调用 Android `SpeechRecognizer` / `TextToSpeech`；真机 `RABI_GLASS_ANDROID_STATUS` 为 `speechRecognizer=false;ttsReady=false`，启动 ASR 返回 `asr:speech_recognizer_unavailable`，TTS 返回 `tts:tts_not_ready`。 |
| 可继续推进 | RokidAiSdk | 官方 demo 说明它是 Android APK 内集成语音服务的正式路线，能回 ASR 文本、NLP/action、语音事件，并能调用 TTS。 |
| 阻塞中 | RokidAiSdk 真机闭环 | 需要开放平台产品凭证和 SDK 资产准备完成，不能用 CXR 授权 token 替代。 |
| 阻塞中 | 当前手机 ABI | 官方 RokidAiSdk 1.4.3 文档要求 `armeabi-v7a`，并说明目前没有 64 位 so；当前测试手机 `<adb-serial>` 只上报 `arm64-v8a`，`ro.product.cpu.abilist32` 为空。 |
| 已验证 | 眼镜端 RokidAiSdk ABI / assets | 眼镜端 32 位 APK 已打包官方 1.4.3 AAR 和 `workdir_asr_cn`，真机回 `assets=true;nativeAbi=true;recordAudioPermission=true`，CXR CustomCmd 桥仍可用。 |
| 阻塞中 | 眼镜端 RokidAiSdk 启动 | 无私有开放平台凭证时，`glass_rokid_ai_start` 正确返回 `RABI_ROKID_AI_ERROR:not_ready`，缺 `key/secret/deviceTypeId/deviceId/seed`。 |
| 已验证为当前不可用 | Phone SDK ClassicBT 设备消息链路 | 系统 bonded devices 能看到 `Glasses_3268`。`phone.sdk:2.2.0-E` 和 `2.5.1-P` 均实测 `connectToServer` 回调 `success=false`；新增官方式 scan->connect 探针后，Phone SDK 扫描到 5 个非 Glass/Rokid 设备，没有扫到可连接眼镜候选，只能回退 bonded。`GlassDeviceInfo.present=false`，不能作为当前在线 ASR/TTS 的就绪条件。 |
| 已验证为当前不可用 | Phone SDK 官方系统信息消息 | 按官方 demo 的 `RokidESecurity` / `GET_SYSTEM_INFO` 路线发出 ClassicBT 和 P2P 文本消息，API 调用层返回已请求，但 5 秒内没有 `SYSTEM_INFO_RESPONSE`；同时 `classicConnected=false`、`message=false`、`deviceAuth=false`。这说明官方设备服务消息通道也没有建立。 |
| 已验证为当前不可用 | Phone SDK P2P 设备媒体链路 | `WifiP2PClientService` 存在，`initialize/startDiscoverPeers` 成功；补齐 `ACCESS_FINE_LOCATION/ACCESS_COARSE_LOCATION` 后，真机仍 `peers=0`、`connected=false`，且 `keepConnect` 明确返回“蓝牙未连接，请先连接上蓝牙”。所以当前缺的是 Phone SDK 自己的 BT/P2P 设备会话，不是单纯 Android 权限。 |
| 已验证为当前不可用 | Phone SDK 设备媒体握手 | 按官方 `VideoReceiveActivity` 顺序先请求 video、收到首帧后再请求 audio，当前真机仍在首个视频包前超时，说明不是单纯 audio 请求顺序问题。 |
| 部分可用 | Android 系统 TTS/ASR 旁路 | `android_tts` 已通过 Android `TextToSpeech` 收到 `onDone`；给 `com.xiaomi.mibrain.speech` 补麦克风权限后，`android_asr_tts_loop` 能收到 Android 系统 ASR final 文本。该路线不等于 Rokid 原生 ASR/TTS，也不能证明眼镜麦克风。 |
| 已验证为当前不可用 | Android Headset/HFP 语音通道 | `BluetoothProfile.HEADSET` proxy 可取得，系统 bonded devices 能看到 `Glasses_3268`，但 `getConnectedDevices()` 为空，目标只能从 bonded 兜底选出，`headsetState=disconnected`，`startVoiceRecognition()` 返回 `false`。 |

一句话：CXR-L 能桥设备和自定义应用；RokidAiSdk 才像完整 ASR/TTS 引擎。两者不能互相替代。

2026-07-05 11:27 最新复测还修掉了一个历史遗留崩溃：`phone.sdk` 在触发 P2P/WS 相关组件时需要 `org.slf4j.LoggerFactory`，APK 补 `org.slf4j:slf4j-api:1.7.36` 后，不再出现 `NoClassDefFoundError` / `FATAL EXCEPTION`。修复崩溃后，Phone SDK 前置检查仍为 `readyForPhoneVoice=false`，说明当前失败点已经不是运行时依赖缺失，而是设备私有连接链路未建立。

2026-07-05 12:15 继续复核眼镜端 ABI：内置眼镜 APK `0.1.4` 的 `RABI_STATUS` 已返回 `device=Rokid/RG-glasses/sdk32`、`supportedAbis=arm64-v8a,armeabi-v7a,armeabi`、`supported32BitAbis=armeabi-v7a,armeabi`、`supported64BitAbis=arm64-v8a`。这说明官方 1.4.3 `armeabi-v7a` SDK 在这台手机上不适合直接集成，但眼镜端具备 32 位运行能力；下一条可验证路线应是“眼镜端独立 RokidAiSdk 探针”，前提是 SDK 资产和开放平台凭证齐备。

2026-07-05 12:22 已继续把眼镜端测试 APK 强制为 `armeabi-v7a`：`glass-asr` 增加 `ndk.abiFilters "armeabi-v7a"`，版本升到 `0.1.5`。真机 `diag` 仍能通过 CXR CustomCmd 回包，且 `nativeLibraryDir=/data/app/.../com.rabi.link.glass.../lib/arm`。这说明“32 位眼镜 APK + CXR 消息桥”已验证可同时成立，后续接官方 RokidAiSdk 的实验应优先落在眼镜端 32 位 APK，而不是手机端 arm64-only APK。

2026-07-05 12:39 已把官方 `basic/turenso/nlpconsumer/audioai 1.4.3` 和 `workdir_asr_cn` 接入眼镜端 32 位 APK。新增 `glass_rokid_ai_probe/start/stop/tts` 手机命令，经 CXR CustomCmd 转成眼镜端 `RABI_GLASS_ROKID_AI_*`。真机 readiness：

```text
RABI_ROKID_AI_STATUS:assets=true;nativeAbi=true;requiredNativeAbi=armeabi-v7a;device32BitAbis=armeabi-v7a,armeabi;device64BitAbis=arm64-v8a;recordAudioPermission=true;credentials=configured=false;missing=key,secret,deviceTypeId,deviceId,seed;workDir=workdir_asr_cn;configFile=lothal_single.ini;serviceConnected=false;bound=false;recording=false
```

无凭证启动被安全门控拦下：

```text
RABI_ROKID_AI_ERROR:not_ready:assets=true;nativeAbi=true;recordAudioPermission=true;credentials=configured=false;missing=key,secret,deviceTypeId,deviceId,seed
```

因此眼镜端路线当前不再是 ABI/打包阻塞，而是凭证和真实服务启动验证阻塞。下一步只能在不提交密钥的前提下，通过 ADB/base64 extras 或本机私有配置把五段开放平台凭证注入眼镜端，再验证 `IRokidAudioAiService` 是否能连接、是否回 `RABI_ROKID_AI_ASR:<text>`。

2026-07-05 12:55 已补上本机私有配置入口：`scripts/Set-RokidGlassAiSdkConfig.ps1` 默认读取 `secrets/rokid-ai-sdk.properties`，然后发 `glass_rokid_ai_save_config` 到手机，再由手机通过 CXR CustomCmd 发给眼镜端 `RABI_GLASS_ROKID_AI_CONFIG_B64:<json>`。眼镜端只保存在内存；本项目日志会把配置 payload 显示为 `<redacted>`。这一步只是把“钥匙孔”做好，仍然需要真实开放平台凭证才能继续验证 ASR/TTS。

2026-07-05 13:23 已把同一组 RokidAiSdk 凭证入口补到手机 APK 测试页：第 09 卡片可填写 `Key` / `Secret` / `deviceTypeId` / `deviceId(sn)` / `seed` / `workDir` / `configFile`，点击“保存 AI 配置”写入本机 SharedPreferences；第 07 卡片在眼镜 APK 启动后可点“发送眼镜 AI 配置”，把同一组配置经 CXR CustomCmd 发给眼镜端。新版 `app-debug.apk` 已构建并安装到测试手机 `<adb-serial>`。这仍不等于 ASR/TTS 已成功，只是把拿到官方凭证后的真机验证路径做成了 UI。

2026-07-05 13:20 左右，开放平台账号已提交认证/审核。当前外部状态是等待 Rokid 后台审核和语音接入权限；审核通过前，本项目只能继续做无凭证 readiness 和 UI/消息桥验证。

2026-07-05 后续确认：开放平台里已创建 `RabiLink` 应用，页面显示 `appId` / `appSecret`，但“选用能力”仍为 0。这个状态只能说明应用壳已创建，不等于 RokidAiSdk 语音产品凭证已齐。下一步应点击“添加能力”，优先寻找“语音接入 / RokidAiSdk / AI 语音 / 语音 SDK / 设备语音接入”相关能力；只有能力配置或设备/SN 管理里出现 `Key` / `Secret` / `deviceTypeId` / `deviceId(sn)` / `seed`，才能进入眼镜端 RokidAiSdk 真机验证。

2026-07-05 继续查看“新增能力”弹窗：当前账号可选能力只有“升级策略”和“数字人 UAE SDK”，没有“语音接入 / RokidAiSdk / AI 语音 / 语音 SDK / 设备语音接入”。因此当前不是应用未创建，而是开放平台账号/应用没有语音能力入口。页面上的应用 `appId` / `appSecret` 不应记录到仓库，也不应填入 RokidAiSdk 的 `key` / `secret` 字段；如果 secret 已经在聊天或日志里出现，后续正式测试前应在平台里重置或重新创建应用密钥。

```powershell
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -CreateTemplate
.\scripts\Test-RokidGlassAiSdkReadiness.ps1
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -Serial <adb-serial> -ProbeAfter
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -Serial <adb-serial> -StartAfterConfig
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -Serial <adb-serial> -Clear
```

审核通过并拿到五段凭证后，也可以走一键试跑脚本。它会先检查配置完整性；配置缺失时只输出 `waiting_credentials`，不会乱启动 SDK。有完整 `secrets/rokid-ai-sdk.properties` 后，它会发配置、probe、start、tts、收证据并运行完成断言：

```powershell
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -ProbeOnly
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial>
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -ConfirmHeardTts
```

如果凭证是直接在手机 APK 第 09 卡片里填写并保存的，本机脚本不会读取手机 SharedPreferences。此时先在第 07 卡片点“发送眼镜 AI 配置”，再用脚本跳过本机配置发送，只负责启动、TTS、收证据和断言：

```powershell
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -SkipConfigSend -ProbeOnly
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -SkipConfigSend
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -SkipConfigSend -ConfirmHeardTts
```

`-ProbeOnly` 只做配置发送、状态查询和证据收集，不启动 SDK、不发 TTS；适合审核刚通过、还不确定凭证和眼镜端状态时先探路。

## 官方 Demo 证据

已拉取参考工程：

```text
out/reference/RokidAiSdkDemo
```

该目录只作为本机参考资料和 SDK 资产来源，不应提交。`out/` 和 `secrets/` 已在本 example 的 `.gitignore` 中排除。

关键文件：

| 文件 | 作用 |
| --- | --- |
| `app/build.gradle` | 使用 `basic-1.4.3.aar`、`turenso-1.4.3.aar`、`nlpconsumer-1.4.3.aar`、`audioai-1.4.3.aar`；只声明 `armeabi-v7a`。 |
| `app/src/main/assets/workdir_asr_cn/` | ASR 工作目录，包含 `lothal_single.ini`、`lothal_double.ini`、`rasr.emb.*.ini`，以及 `model/emb/output_graph.bin`、`model/emb/symbol_table.txt` 等模型/配置资产。 |
| `PhoneAudioActivity.java` | 前台测试页，启动语音服务、注册 listener、接收 ASR/NLP/语音事件、调用 TTS。 |
| `service/TipsService.java` | 服务化示例，启动同一个语音服务并监听 ASR 文本。 |

关键接口：

| 能力 | Demo 接口 | 对 `com.rabi.link` 的意义 |
| --- | --- | --- |
| 启动语音服务 | `AudioAiConfig.getIndependentIntent(context)` + `startService(intent)` | 可封装为 `RokidAiSdkVoiceController.start(config)`。 |
| 传入配置 | `AudioAiConfig.PARAM_SERVICE_START_CONFIG` + `ServerConfig` | 所有凭证和 ASR 工作目录必须来自外部配置，不写死。 |
| 注册回调 | `IRokidAudioAiService.registAudioAiListener(listener)` | 可把回调转成 `ProbeResult`、日志和消息端事件。 |
| ASR 中间片段 | `onIntermediateSlice(int id, String asr, boolean isLocal)` | 可用于实时字幕或调试，不宜当最终用户输入。 |
| ASR 完整文本 | `onIntermediateEntire(int id, String asr, boolean isLocal)` | 这是消息端最需要的 `voice_transcript` 来源。 |
| NLP/action | `onCompleteNlp(int id, String nlp, String action, boolean isLocal)` | 可用于确认 Rokid 云技能链路，但 RabiRoute 初期不依赖它。 |
| 语音事件 | `onVoiceEvent(int id, int event, float sl, float energy, String extra)` | 可用于展示唤醒、能量、角度等状态。 |
| 识别错误 | `onRecognizeError(int id, int errorCode)` | 必须进固定日志和证据包。 |
| 凭证校验失败 | `onVerifyFailed(deviceTypeId, deviceId, seed, mac)` | 这是开放平台配置错误的关键诊断。 |
| TTS | `IRokidAudioAiService.playTtsVoice(text)` | 可做显式外发动作，后续接 RabiRoute 安全门。 |

## 需要的开放平台配置

RokidAiSdk demo 的 `ServerConfig` 需要这些字段：

| 字段 | 来源 | 是否可缺省 | 说明 |
| --- | --- | --- | --- |
| `key` | Rokid 开放平台产品 | 否 | 产品 Key。 |
| `secret` | Rokid 开放平台产品 | 否 | 产品 Secret，不能提交到仓库。 |
| `deviceTypeId` | Rokid 开放平台产品 | 否 | 产品设备类型。 |
| `deviceId` | 设备 SN 或开放平台要求的设备 ID | 否 | demo 注释要求 6-15 位字母数字；实际以平台文档为准。 |
| `seed` | 设备 seed | 否 | 绑定/校验使用。 |
| `workDir` | APK assets | 否 | demo 为 `workdir_asr_cn`。 |
| `configFile` | APK assets | 否 | 单麦 `lothal_single.ini`，双麦 `lothal_double.ini`。 |
| `armeabi-v7a` runtime | Android 设备 ABI | 否 | 官方文档要求 `abiFilters "armeabi-v7a"`，当前 1.4.3 demo 未提供 64 位 so。 |

### 凭证来源

这些不是从 Rokid AI App 反编译出来的，也不是 CXR 授权 token。官方文档的来源路径是：Rokid 开放平台控制台的“语音接入”里创建对应产品；后台生成产品级 `Key` / `Secret` / `deviceTypeId`，并为设备生成测试用 `deviceId(sn)` / `seed`。同一份文档还说明，每组 `deviceId` / `seed` 会和设备网络 `macAddress` 绑定，测试用数量有限，商用批量 SN/Seed 需要联系 Rokid 商务。

官方资料：

- Rokid 开放平台控制台：<https://open.rokid.com/>
- <https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/RokidAiSdk/RokidAiSdk.html>
- <https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/rookie-guide/rookie-guide-end.html>

### 注册/申请入口

当前截图里的“项目管理 / 创建应用”只说明账号已经能进入开放平台控制台，还不能说明已经开通了 RokidAiSdk 语音产品权限。需要按下面顺序找：

1. 打开 Rokid 开放平台控制台：<https://open.rokid.com/>
2. 进入“项目管理”，点击“创建应用”。
3. 在创建流程里找“语音接入 / RokidAiSdk / AI 语音 / 语音 SDK”这类入口。
4. 创建语音产品后，后台应给出产品级 `Key`、`Secret`、`deviceTypeId`。
5. 再进入对应产品的设备/SN 管理，申请或生成测试设备的 `deviceId(sn)` 和 `seed`。

如果“创建应用”里只有普通应用上架、设备管理、基础信息，没有“语音接入”或类似入口，就说明当前账号权限不够。此时要走 Rokid 开发者支持/商务开通，不要继续反编译找 key，也不要把 CXR 授权 token 当成 RokidAiSdk 凭证。

如果当前账号后台没有“语音接入”或不能创建语音产品，下一步不是继续改 APK，而是向 Rokid 开通权限。可以直接发下面这段：

```text
你好，我们正在测试 RokidAiSdk Android APK 级语音方案，用于验证眼镜端/Android APK 内原生 ASR 文本回调和 TTS 播放。

当前已完成：
- APK 已集成 basic/turenso/nlpconsumer/audioai 1.4.3 AAR；
- 已打包 workdir_asr_cn；
- 设备侧支持 armeabi-v7a；
- 已能启动测试 APK 并通过 CXR CustomCmd 下发 RABI_GLASS_ROKID_AI_* 测试命令。

现在缺 RokidAiSdk 初始化所需的开放平台测试凭证：
- Key
- Secret
- deviceTypeId
- deviceId(sn)
- seed

请问当前账号如何开通“语音接入”产品创建权限，或如何申请一组 RokidAiSdk 测试用 deviceId/sn + seed？
```

如果已经创建普通应用，但“新增能力”里仍没有语音入口，可以补发：

```text
补充一下：当前账号已经能创建开放平台应用，应用名为 RabiLink；但在“管理应用 -> 新增能力”弹窗里，只看到“升级策略”和“数字人 UAE SDK”，没有“语音接入 / RokidAiSdk / AI 语音 / 语音 SDK / 设备语音接入”相关能力。

我们需要的是 RokidAiSdk Android APK 级语音能力，用于验证：
- ASR final 文本回调；
- TTS 播放；
- 测试设备 deviceId(sn) / seed 校验。

请问这个能力是否需要单独开通，或是否有新的申请入口？
```

配置只能来自本机私有 JSON 或环境变量。不要把真实值写入 Java/Kotlin、Gradle、README、证据包或 git。

现在有两种配置方式：

1. 手机 APK UI：第 09 卡片填写五段凭证，点“保存 AI 配置”；眼镜 APK 启动后，在第 07 卡片点“发送眼镜 AI 配置”。
2. 电脑脚本：使用 `secrets/rokid-ai-sdk.properties` 和 `Set-RokidGlassAiSdkConfig.ps1`，适合批量复测和留证据包。

建议本机私有配置路径：

```text
secrets/rokid-ai-sdk-config.json
```

示例结构：

```json
{
  "key": "",
  "secret": "",
  "deviceTypeId": "",
  "deviceId": "",
  "seed": "",
  "workDir": "workdir_asr_cn",
  "configFile": "lothal_single.ini"
}
```

也可以用环境变量：

```powershell
$env:ROKID_AI_KEY = "<key>"
$env:ROKID_AI_SECRET = "<secret>"
$env:ROKID_AI_DEVICE_TYPE_ID = "<deviceTypeId>"
$env:ROKID_AI_DEVICE_ID = "<deviceId>"
$env:ROKID_AI_SEED = "<seed>"
```

## 和现有 CXR 探针的边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| CXR-L / CXR-M | 授权、连接、CustomView、音频流、拍照、设备信息、亮度/音量、自定义应用安装/启动、CustomCmd。 | 不保证直接返回 ASR 文本，不保证 CustomApp 内可绑定 Glass3 Security Service。 |
| Glass3 SDK | 眼镜原生服务、眼镜端 ASR/TTS、MessageService。 | 当前 CustomApp 环境实测服务包不可见。 |
| Phone SDK ClassicBT | 手机 SDK 内部的 device/message/auth 通道，是 `GlassDeviceInfo` 和在线语音 app token 的前置条件之一。 | 当前真机对已配对 `Glasses_3268` 调 `connectToServer` 返回 false；系统 A2DP 连接不能替代这个通道。 |
| RokidAiSdk | Android APK 内语音服务、ASR 文本、NLP/action、TTS。 | 需要开放平台产品凭证和 SDK 资产，不是 CXR 授权 token 的附属能力。 |
| 眼镜端 RokidAiSdk 探针 | 把官方 32 位语音 SDK 放入眼镜端测试 APK，绕开手机 arm64-only 限制，直接在眼镜 Android 环境里验证 ASR/TTS 服务启动。 | AAR/assets/ABI/录音权限/CXR 回包已验证；当前只因缺私有开放平台凭证而不启动。 |
| Android 系统语音 | Android `SpeechRecognizer` / `TextToSpeech`，可作为音频眼镜/显示眼镜场景的系统层对照探针。 | 当前 TTS 可以调起小米 TTS service 并收到 `onDone`；补齐小米系统语音服务麦克风权限后 ASR 能返回文本；系统音频设备列表仍没有出现 `Glasses_3268`，所以不能当作眼镜原生链路。 |
| Android 系统语音蓝牙路由 | 手机 APK 主动请求 `setCommunicationDevice(TYPE_BLUETOOTH_SCO/BLE_HEADSET)` / `startBluetoothSco()`，尝试让系统 ASR/TTS 使用眼镜蓝牙麦克风和扬声器。 | 当前 `communicationDevices` 只有听筒和扬声器，主动路由回 `routed=false; target=none; scoOn=false`，所以手机系统语音暂时也不能证明经眼镜输入/输出。 |
| Android Headset/HFP 语音通道 | 手机 APK 通过 `BluetoothHeadset.startVoiceRecognition()` 尝试拉起蓝牙耳机语音识别链路。 | 当前 `Glasses_3268` 只作为 bonded 设备可见，HEADSET state 为 `disconnected`，`startVoiceRecognition=false`；不能作为眼镜麦克风输入通道。 |
| 眼镜端 Android 系统语音 | 内置眼镜 APK 直接调用眼镜系统里的 `SpeechRecognizer` / `TextToSpeech`。 | 当前 CustomApp 真机内 `SpeechRecognizer.isRecognitionAvailable=false`，`TextToSpeech` 不 ready，因此不能作为眼镜端原生文本或播报入口。 |
| RabiRoute 桥 | 把 ASR 文本转成 `voice_transcript`，把 TTS 请求作为显式外发动作。 | 不伪造 ASR/TTS 成功，不绕过授权校验。 |

Android 系统语音路线已提供两个稳定监听口：logcat `RABI_ANDROID_ASR:<text>` / `RABI_ANDROID_TTS_OK:<text>`，以及脚本 summary 的 `results.androidSystemAsrFinalText` / `results.androidSystemTtsDoneText`。`Watch-RokidNativeVoiceEvents.ps1` 会把 `RABI_ANDROID_ASR:<text>` 归一为 `type=asr_text`、`kind=android_system`，`Start-RokidNativeVoiceWebhookBridge.ps1` 可以继续把它转成 RabiRoute `voice_transcript`。它可以先作为消息端备用输入输出，但正式 Rokid 原生路线仍以 Glass SDK / Phone SDK / RokidAiSdk 的回包为准。

2026-07-05 眼镜端增强诊断后，`diag` 能通过 CXR CustomCmd / Phone SDK 消息通道到达眼镜测试 APK 并返回增强版 `RABI_STATUS`。真机状态为 `Rokid/RG-glasses/sdk32`，可见 `com.rokid.cxrservice` 和 `com.rokid.os.sprite.*` 包，但 `com.rokid.security.system.server`、`com.rokid.security`、`com.rokid.glass.service` 等 Glass SDK Security Service 候选包均不可见；`GlassSdk.isReady=false`、`asr=false`、`tts=false`、`serviceConnected=false`。因此这台环境上 CXR/CustomApp 可用，但不能把 Glass3 SDK 的 ASR/TTS 当作可行闭环。

## Phone SDK ClassicBT 追加实测

2026-07-05 新增 `phone_bt_scan`、`phone_bt_connect`、`phone_bt_auth` 探针后，真机结果如下：

| 步骤 | 证据 | 结论 |
| --- | --- | --- |
| CXR 会话 | `connectGlassAppSession=true`、`onCXRLConnected=true` | CXR-L 应用桥仍然可用。 |
| Phone SDK 扫描 | `Phone SDK BT scan finished found=6`，未出现眼镜名 | 已连接/已配对眼镜不一定会被 SDK scan 发现。 |
| 系统 bonded 设备 | `Phone SDK BT bonded candidates total=14 rokidLike=1 [name=Glasses_3268 ...]` | 手机系统能看到已配对眼镜候选。 |
| Phone SDK 连接 | `Phone SDK BT connect callback success=false target=name=Glasses_3268 ...` | Phone SDK 没有成功建立自己的 ClassicBT client 连接。 |
| readiness | `classicConnected=false;message=false;deviceAuth=false;readyForDeviceMessages=false` | 当前不能走依赖 Phone SDK device/message/auth 的在线 ASR/TTS 激活链路。 |

因此，当前不能再假设“手机蓝牙已连眼镜 = Phone SDK 已连眼镜”。继续推进原生 ASR/TTS 时，要么取得 Rokid 官方说明如何让第三方 Phone SDK 复用/接管 Rokid AI App 的眼镜连接，要么改走不依赖该 ClassicBT 通道的正式 RokidAiSdk / 外部 ASR 路线。

2026-07-05 追加 `scripts/Test-RokidPhoneVoicePrerequisites.ps1`，把 `phone_device_info`、`phone_auth_probe`、`phone_device_handshake` 和可选 `phone_bt_connect` 编排成一个前置检查。它只判断“Phone SDK 在线 ASR/TTS 是否具备启动条件”，不把命令送达当成 ASR/TTS 成功。

运行：

```powershell
.\scripts\Test-RokidPhoneVoicePrerequisites.ps1 -Serial <adb-serial> -WaitSeconds 8 -IncludeBtConnect
```

首次完整前置检查证据：

```text
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-094913.json
```

2026-07-05 11:27 修复 `slf4j-api` 缺失崩溃并重新安装 APK 后，最新证据为：

```text
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-112743.json
```

当前解析结果：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `readyForPhoneVoice` | false | Phone SDK 在线 ASR/TTS 前置条件不满足。 |
| `deviceInfoPresent` | false | Phone SDK 尚未缓存 `GlassDeviceInfo`。 |
| `deviceIdReady` | false | 无眼镜 `deviceId`，不能生成手机侧在线语音 app token。 |
| `authConfigured` | false | 本机未配置 Rokid 在线语音 AK/SK。 |
| `authReady` | false | `x-app-authorization` / `x-user-authorization` 未就绪。 |
| `handshakeTimedOut` | true | `phone_device_handshake` 5 秒超时。 |
| `videoAudioVideoSeen` | false | 按官方 video-first 顺序请求后，10 秒内没有收到首个视频包。 |
| `videoAudioAudioSeen` | false | 因为没有首个视频包，探针没有进入 audio 请求阶段。 |
| `videoAudioTimedOut` | true | `phone_device_video_audio_handshake` 在 video 阶段超时。 |
| `companionObserved` | true | `com.rabi.link` 已能观察系统 Companion presence，说明 association/observe 不是当前主缺口。 |
| `deviceLinkLine` | `scan fallback to bonded candidates` | 官方式 ClassicBT 扫描没有发现可连接眼镜候选，只能回退系统 bonded 设备。 |
| `officialSystemInfoRequested` | true | 官方 `RokidESecurity` / `GET_SYSTEM_INFO` 请求已发出。 |
| `officialSystemInfoResponded` | false | 5 秒内没有 `SYSTEM_INFO_RESPONSE`。 |
| `officialSystemInfoTimedOut` | true | 官方系统信息消息通道未闭环。 |
| `p2pServicePresent` | true | Phone SDK 的 `WifiP2PClientService` 可用。 |
| `p2pConnected` | false | 当前 Phone SDK P2P 未连接。 |
| `p2pReadyForDeviceMedia` | false | 设备视频/音频媒体链路前置条件不满足。 |
| `btConnected` | false | 对系统 bonded `Glasses_3268` 调 Phone SDK `connectToServer` 仍返回 `success=false`。 |

该证据来自升级到 `phone.sdk:2.5.1-P`、`glass3.open.sdk:2.5.1-P`、`client-l:1.1.0` 并覆盖安装后的 APK：

```text
app/build/outputs/apk/debug/app-debug.apk
Length=294077070
install -r: Success
```

所以 Phone SDK 设备消息链路的当前不可用状态不是旧版依赖残留导致的。

2026-07-05 继续对照官方 `glass3sdkdemo/glass3sdkphonedemo` 的 `VideoReceiveActivity.kt` 后，补了 `phone_device_video_audio_handshake`：先 `requestVideoStream(...)`，等待 `onNv21Data` / `onVideoH264Stream` 首帧，再调用 `requestAudioStream(...)`。真机结果是：

```text
Phone SDK device video/audio handshake requested video tag=RabiPhoneDeviceVideoProbe fps=15 bitrate=2000000
Phone SDK device video/audio handshake video timeout after 10000ms
Phone SDK device video/audio handshake finish reason=video timeout video=false audioRequested=false audio=false
Phone SDK glass device info after video/audio handshake present=false deviceId=false/0 deviceType=false deviceSubType=false btMac=false wifiMac=false p2pMac=false osVersion=false readyForAppToken=false
```

固定证据：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-093549.txt
```

这把问题范围缩小了一层：不是“音频流按钮调用太早”，而是 Phone SDK 设备服务的媒体/消息通道没有真正和眼镜建立起来；在首个 video 回包都没有的情况下，后面的音频流、`GlassDeviceInfo`、在线 ASR/TTS token 都不会自然 ready。

2026-07-05 继续把官方 `ClassicBtActivity -> BtWifiConnectActivity -> DeviceLinkerManager` 的串行思路压缩成 `phone_device_link_probe`：先用 Phone SDK ClassicBT scan 找 Glass/Rokid 候选，找到就连接；找不到再回退系统 bonded `Glasses_3268`，BT 成功后才触发 P2P。真机结果：

```text
Phone SDK device link probe scan requested durationMs=12000
Phone SDK BT scan found name=nonRokidDevice addressSuffix=70:C4
Phone SDK BT scan found name=nonRokidDevice addressSuffix=72:2E
Phone SDK BT scan found name=nonRokidDevice addressSuffix=F8:D7
Phone SDK BT scan found name=nonRokidDevice addressSuffix=F1:5D
Phone SDK BT scan found name=nonRokidDevice addressSuffix=E5:5B
Phone SDK BT scan finished found=5
Phone SDK device link scan fallback to bonded candidates
Phone SDK BT bonded candidates total=14 rokidLike=1 [name=Glasses_3268 addressSuffix=45:55]
Phone SDK BT connect callback source=bonded success=false target=name=Glasses_3268 addressSuffix=45:55
Phone SDK glass device info probe present=false deviceId=false/0 deviceType=false deviceSubType=false btMac=false wifiMac=false p2pMac=false osVersion=false readyForAppToken=false
```

固定证据：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-101812.txt
out/rokid-native-voice/bluetooth-manager-20260705-1019.txt
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-102313.json
```

系统 `dumpsys bluetooth_manager` 同时显示 `Glasses_3268` 是 bonded `DUAL` 设备，但当前系统侧主要建立的是 `A2DP`、`HEADSET`、`PBAP` 等音频/电话 profile；这和 Phone SDK ClassicBT 私有消息链路 `classicConnected=false;message=false;deviceAuth=false` 不矛盾。也就是说，“眼镜能当蓝牙音频设备连上手机”仍不能推出“Phone SDK 已拿到设备消息通道”。

外部中文文档也支持这个判断：Rokid 蓝牙排查页把蓝牙定义为扫描发现、基础连接、小消息/控制指令和 P2P 协商入口，并要求确认权限、眼镜是否被其他手机连接、系统/App 是否匹配、扫描过滤条件；一体化配对页明确流程是 `connectToServer()` 成功后再 `sendConnectP2pRequest()`，然后按当前蓝牙设备同名的 Glass P2P 设备调用 `connectDevice()`。当前真机卡在第一步“扫描不到 Glass/Rokid 命名目标，bonded 直连 false”，所以后续 P2P/媒体流/ASR/TTS 均不会自然 ready。

```text
https://x-docs.rokid.com/docs/faq/蓝牙问题排查.html
https://x-docs.rokid.com/docs/代码示例/10-device-connection/02-蓝牙与-P2P-一体化配对.html
```

2026-07-05 再对照官方主界面的 `autoConnectP2p()` / `sendConnectP2pRequest()` / `connectP2p()` 流程后，新增 `phone_p2p_probe`。单独运行结果：

```text
Phone SDK P2P isConnect callback connected=false
Phone SDK P2P keepConnect source=isConnect error code=-1 message=蓝牙未连接,请先连接上蓝牙
Phone SDK P2P sendConnectP2pRequest callback success=false
Phone SDK P2P initialize callback success=true
Phone SDK P2P startDiscoverPeers callback success=true
Phone SDK P2P connectionInfo source=isConnect present=true groupFormed=false isGroupOwner=false ownerAddress=
Phone SDK P2P groupInfo source=isConnect present=false
Phone SDK P2P probe timeout after 15000ms peers=0 matched=false
Phone SDK P2P keepConnect source=timeout error code=-1 message=蓝牙未连接,请先连接上蓝牙
Phone SDK P2P probe service=true connected=false peers=0 matchedPeer=false readyForDeviceMedia=false
```

固定证据：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-101011.txt
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-100743.json
```

这次还补齐了官方样例需要的定位权限：`ACCESS_FINE_LOCATION`、`ACCESS_COARSE_LOCATION` 均已声明并授权；MIUI 需要同时把 UID 级 `FINE_LOCATION` appops 从 `ignore` 调成 `foreground`，否则包级 `pm grant` 后页面仍显示精确位置未授权。授权修正后，P2P 探针仍保持上述失败形态。

这说明 Phone SDK 的 P2P 服务本身不是空对象，发现流程也能启动；但当前眼镜没有以 Phone SDK 可发现/可连接的 P2P peer 形态出现，且 SDK 的 keep-connect 状态直接指向“蓝牙未连接”。于是 `requestVideoStream(...)` 首帧超时有了更前置的解释：设备媒体通道没有建好，而不是 ASR/TTS API 或视频参数本身先失败。

这条脚本以后可以作为 Phone SDK 语音路线的门禁：只有 `readyForPhoneVoice=true` 后，才值得继续跑 `phone_init`、`phone_asr_start` 和 `phone_tts` 的真机闭环；否则 UI 继续隐藏在线 ASR/TTS 测试项，ADB 命令也只应记录未就绪原因。

## 最小实施任务

| 状态 | 任务 | 验收 |
| --- | --- | --- |
| 已完成 | 拉取并阅读 `RokidAiSdkDemo` | 本文列出关键 AAR、assets、接口和凭证字段。 |
| 已完成 | 新增 readiness 检查 | `scripts/Test-RokidAiSdkReadiness.ps1` 能检查 AAR、assets、配置字段，不输出密钥明文。 |
| 已完成 | 把 RokidAiSdk AAR 和 assets 接入 | `:app:assembleDebug` 成功，APK 打包 `basic/turenso/nlpconsumer/audioai` 和 `workdir_asr_cn`。 |
| 已完成 | 新增 `RokidAiSdkVoiceBridge` | 配置化启动 `IRokidAudioAiService`，注册 listener，写 `RABI_ROKID_AI_*` 固定日志。 |
| 已完成 | 测试页新增 RokidAiSdk 卡片 | 第 09 卡片展示配置状态、服务状态、ASR 文本、TTS 请求、拾音控制和错误。 |
| 已完成 | 补充拾音/TTS 控制命令 | 支持 `rokid_ai_start/stop/tts/pickup/pickup_off`。 |
| 已完成 | 补充 AAR/设备 ABI 自检 | `scripts/Test-RokidAiSdkAbi.ps1` 输出 AAR native ABI 和设备 ABI 是否兼容。 |
| 部分完成 | 消息端桥接 | `onIntermediateEntire` 已输出 `RABI_ROKID_AI_ASR:<text>`，可被 watcher 接成 `voice_transcript`；但当前设备还不能实际跑到 ASR final。 |
| 待做 | 真机验收 | 收到非空 ASR 文本，TTS 实际播报，且无 `onVerifyFailed` / `FATAL EXCEPTION`。 |

## Readiness 检查

只读检查：

```powershell
cd <repo>\examples\android-rabi-link-probe
.\scripts\Test-RokidAiSdkReadiness.ps1
```

带当前手机 ABI 检查：

```powershell
.\scripts\Test-RokidAiSdkReadiness.ps1 -Serial <adb-serial>
```

指定私有配置：

```powershell
.\scripts\Test-RokidAiSdkReadiness.ps1 -ConfigPath .\secrets\rokid-ai-sdk-config.json
```

严格模式，缺任一项时返回非零退出码：

```powershell
.\scripts\Test-RokidAiSdkReadiness.ps1 -FailOnMissing
```

输出文件：

```text
out/rokid-ai-sdk/rokid-ai-sdk-readiness-summary-*.json
```

这个检查通过只代表“可以开始接正式 SDK”，不代表 ASR/TTS 已打通。真正完成仍必须有真机 `onIntermediateEntire` 文本、`playTtsVoice` 调用结果和人工听到播报的证据。

## 当前手机 ABI 判定

2026-07-05 在当前 ADB 设备 `<adb-serial>` 上执行：

```powershell
adb shell getprop ro.product.cpu.abilist
adb shell getprop ro.product.cpu.abilist32
adb shell getprop ro.product.cpu.abilist64
```

结果：

```text
arm64-v8a
<empty>
arm64-v8a
```

这和官方 `RokidAiSdk 1.4.3` 的 `armeabi-v7a` 要求冲突。因此在这台手机上继续把 demo 里的 1.4.3 AAR 直接塞进 `com.rabi.link`，很可能只能做到编译或安装前失败，不能证明原生 ASR/TTS 可用。

当前工程已经实际接入 1.4.3 AAR 并安装验证：配置导入后，`rokid_ai_start` 会被 APK readiness 拦截为：

```text
nativeAbi=false;requiredNativeAbi=armeabi-v7a;device32BitAbis=<none>;device64BitAbis=arm64-v8a
```

也可以用独立脚本复核：

```powershell
.\scripts\Test-RokidAiSdkAbi.ps1 -Serial <adb-serial>
```

它会列出 `basic-1.4.3.aar` / `turenso-1.4.3.aar` 里的 native ABI，目前只有 `armeabi-v7a`。

下一步只剩两条可验证路线：

| 路线 | 条件 | 说明 |
| --- | --- | --- |
| 取得新版/定制 RokidAiSdk | Rokid 开放平台或商务支持提供 `arm64-v8a` AAR/so | 这是当前手机上最直接的正式 SDK 路线。拿到后更新 readiness 的 AAR/ABI 检查，再接 `IRokidAudioAiService`。 |
| 换支持 32 位 runtime 的 Android 设备 | `ro.product.cpu.abilist` 或 `ro.product.cpu.abilist32` 包含 `armeabi-v7a` | 可用现有 1.4.3 demo SDK 继续验证 ASR/TTS，但语音输入来自运行 APK 的 Android 设备麦克风，不自动等同于眼镜麦克风。 |

## 已安装 Rokid AI App 取证

当前手机安装的 Rokid AI App：

| 字段 | 值 |
| --- | --- |
| 包名 | `com.rokid.sprite.aiapp` |
| 版本 | `1.9.9.0623` |
| native ABI | `arm64-v8a` |

APK 文件表显示 App 内部确实包含 arm64 原生语音资产：

| 类型 | 证据 |
| --- | --- |
| ASR so | `lib/arm64-v8a/librfm-asr.so`、`lib/arm64-v8a/librokid_rfm_asr.so`、`lib/arm64-v8a/libfunasrruntime.so` |
| ASR assets | `assets/rfmasr/rfm-asr.conf`、`assets/rfmasr/rfm_model/v1.3.3/encoder.onnx`、`assets/rfmasr/rfm_model/v1.3.3/ctc.onnx` |
| TTS assets | `assets/tts/languagedata_embedded.bin`、`assets/tts/parameter.cfg`、`assets/tts/voices/voicefont.bin` |

Manifest 侧能看到的外部开放面：

| 组件 | exported | 说明 |
| --- | --- | --- |
| `com.rokid.sprite.aiapp.external.CXRLinkProvider` | true | CXR-L 手机侧 SDK 当前使用的 provider。 |
| `com.rokid.sprite.aiapp.externalapp.service.CXRLinkService` | true | action 为 `com.rokid.sprite.aiapp.externalapp.MEDIA_STREAM_SERVICE`，对应当前 CXR 媒体/应用桥。 |
| `com.rokid.sprite.aiapp.externalapp.auth.AuthorizationActivity` | true | action 为 `com.rokid.sprite.aiapp.externalapp.AUTHORIZATION`，对应当前授权入口。 |
| `com.rokid.sprite.aiapp.library_ai.service.AiService` | false | App 内部 AI service，不是外部可 bind 的公开 ASR/TTS 接口。 |

结论：Rokid AI App 自己有 arm64 原生 ASR/TTS 资产，但当前 manifest 没有发现直接公开的 `ASR` / `TTS` / `SPEECH` action 或可 bind service。现阶段第三方 APK 可稳定使用的还是 CXR provider/service；要拿 App 内部 ASR/TTS，只能等待官方公开 arm64 SDK/API，或继续确认 `CXRLinkService` 是否有未文档化的语音协议，不宜直接依赖加固 App 的内部类。

2026-07-05 追加静态 dex 检查后确认：安装包使用网易易盾 wrapper，`classes.dex` 里能看到 `com.netease.nis.wrapper.MyApplication`，但看不到 `com.rokid.sprite.aiapp` 业务包。也就是说，Rokid AI App 的真实业务代码运行时由壳加载；静态反编译不能作为稳定第三方 API 依据，更不能把内部 ASR/TTS 实现当作可调用接口。

复查脚本：

```powershell
.\scripts\Inspect-RokidAiAppVoiceSurface.ps1 -Serial <adb-serial>
```

输出：

```text
out/rokid-aiapp/inspect-*/rokid-aiapp-voice-surface-summary.json
out/rokid-aiapp/inspect-*/badging.txt
out/rokid-aiapp/inspect-*/manifest-xmltree.txt
out/rokid-aiapp/inspect-*/file-list.txt
```

2026-07-05 复查结果：

| 字段 | 当前值 | 解释 |
| --- | --- | --- |
| `hasArm64NativeVoiceAssets` | true | App 内部确实带有 arm64 ASR/TTS 相关 so 和 assets。 |
| `hasExportedCxrProvider` | true | CXR provider 仍是公开入口之一。 |
| `hasExportedCxrService` | true | CXR service 仍是公开入口之一。 |
| `hasCxrMediaStreamAction` | true | 存在 `com.rokid.sprite.aiapp.externalapp.MEDIA_STREAM_SERVICE`，属于 CXR 媒体/应用桥，不等于 ASR 文本接口。 |
| `hasDirectVoiceAction` | false | manifest 的 `E: action` 节点里没有直接 ASR/TTS/SPEECH/VOICE action。 |
| `hasQueryableCxrProviderRows` | false | `content://com.rokid.sprite.aiapp.cxrl.provider` 根查询没有返回数据，`content call get/query` 返回 null。 |
| `aiServiceExported` | false | `library_ai.service.AiService` 是 App 内部服务，不能作为第三方 APK 公开 bind 入口。 |
| `isPackedByNeteaseNis` | true | 静态 dex package 只看到网易易盾 wrapper。 |
| `dexBusinessPackageVisible` | false | 静态 dex package 看不到 `com.rokid.sprite.aiapp` 业务代码。 |
| `dexOnlyWrapper` | true | 说明当前 APK 静态分析无法确认内部运行时代码的稳定 IPC 细节。 |

本轮固定证据：

```text
out/rokid-aiapp/inspect-20260705-090144/rokid-aiapp-voice-surface-summary.json
```

这个脚本只读取已安装 APK 的 manifest、文件表、provider probe 和 dex package 清单；它适合用来监控 App 更新后“是否新增公开入口”，不能证明运行时代码里一定不存在未文档化协议。当前可证明的是：公开 manifest/provider 层没有 ASR/TTS 文本接口，且静态业务代码不可见，不能把内部实现作为稳定可接入面。

## 2026-07-05 收口验证

当前 debug APK 已重新构建并覆盖安装到手机 `<adb-serial>`：

```text
app/build/outputs/apk/debug/app-debug.apk
```

构建和脚本检查结果：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| PowerShell 解析 | 通过 | `Watch-RokidNativeVoiceEvents.ps1`、webhook、TTS server、stack、ABI、配置和 AI App inspection 脚本均无解析错误。 |
| Android 构建 | 通过 | `:app:assembleDebug` 成功。 |
| APK 安装 | 通过 | `adb install -r app-debug.apk` 返回 `Success`。 |
| RokidAiSdk ABI | 不通过 | `scripts/Test-RokidAiSdkAbi.ps1 -Serial <adb-serial>` 输出 `aarNativeAbis=["armeabi-v7a"]`，`deviceAbis=["arm64-v8a"]`。 |
| RokidAiSdk readiness | 不通过 | `out/rokid-ai-sdk/rokid-ai-sdk-readiness-summary-20260705-085537.json`。 |
| 手机端 `rokid_ai_probe` | 命令可达，但能力未 ready | `out/rokid-native-voice/rokid-native-command-filtered-20260705-085634.txt`。 |
| Rokid AI App 静态 IPC 检查 | 未发现公开 ASR/TTS 入口 | `out/rokid-aiapp/inspect-20260705-090144/rokid-aiapp-voice-surface-summary.json`，且 `dexOnlyWrapper=true`。 |

手机端最新 readiness 原文：

```text
assets=true;nativeAbi=false;requiredNativeAbi=armeabi-v7a;device32BitAbis=<none>;device64BitAbis=arm64-v8a;recordAudioPermission=true;credentials=configured=false;missing=key,secret,deviceTypeId,deviceId,seed;key=<empty>;secret=<empty>;deviceTypeId=<empty>;deviceId=<empty>;seed=<empty>;workDir=workdir_asr_cn;configFile=lothal_single.ini;serviceConnected=false;recording=false
```

这说明当前留下来的不是历史遗留构建问题：APK、UI、命令通道、watcher/webhook 协议和文档证据都已收口；未完成点集中在外部条件，即 `arm64-v8a` 版 RokidAiSdk 或支持 32 位 ABI 的测试手机，以及可安全使用的 Rokid 语音授权。

## 中文社区和官方文档交叉验证

检索到的公开资料可以分成三类，和本地实测基本一致：

| 来源类型 | 看到的能力 | 对当前 APK 的判断 |
| --- | --- | --- |
| CXR-L / CXR-M SDK 文档 | 连接 Rokid AI App、获取眼镜 IO、音频流、拍照、显示/场景、自定义应用或场景控制。 | 这是当前 `com.rabi.link` 已经在走的稳定公开层；它更像设备桥和 IO 桥，不等于直接暴露 ASR 文本。 |
| 中文社区 CXR-M 提词器/翻译案例 | 常见写法是用 CXR-M 做眼镜连接、提词/翻译显示、音频或场景联动，再接阿里云等外部 ASR 做文本识别。 | 可以证明“想语音说”可行，但一般要自己做 ASR 管线；不能证明 Rokid AI App 会把原生识别文本直接发给第三方 APK。 |
| Glass SDK / Sprite Enterprise 语音示例 | 眼镜端有 `GlassSdk.getGlassAsrService()?.startSpeech(...)` 和 `GlassSdk.getGlassOfflineTtsService()?.playTtsMsg(...)` 这类接口。 | 官方存在“眼镜端 ASR/TTS”能力，但当前 CXR CustomApp 环境实测无法 bind `GlassSdk` 依赖的系统服务，所以还不能在我们的嵌入测试 APK 内闭环。 |
| Sprite Enterprise 手机端 ASR/TTS 初始化 | 手机端通过 `PSecuritySDK.getMobileEngineService().initSDK(EngineParam)` 初始化，并把在线语音授权放在 `UserAuthInfo(accessKey, secretKey)`。 | 当前工程已接入 `PSecuritySDK`，本轮新增 AK/SK 本机配置入口；但实测 SDK 会把 `EngineParam` 打到 logcat，因此暂不自动注入真实 AK/SK。 |
| `glass3sdkdemo` 官方示例工程 | 手机端 demo 只排除 `org.slf4j`，没有排除 `phone.sdk.rfmlite`；眼镜端 demo 的 ASR/TTS 仍走 `GlassSdk`。 | `phone.sdk.rfmlite` 是手机端语音/意图链路的一部分；当前探针已升级到 AGP `8.4.2` / Kotlin `1.9.0` / Gradle `8.6` 并恢复打包该 AAR。 |
| 开源 Rokid AI Assistant | 手机端是 AI/STT 中枢，眼镜端负责显示、拍照和输入；语音转文字通过 Gemini/OpenAI Whisper/阿里云/讯飞/火山等多 provider 抽象完成。 | 社区可复现路线更偏“眼镜采集或触发 -> 手机端/云端 STT -> 文本/AI 结果回显”，不是直接调用 Rokid AI App 的内部原生转写文本。 |
| RokidAiSdk 文档 | Android APK 内集成语音 SDK，回 ASR/NLP/事件，并调用 TTS。 | 更接近“原生 ASR/TTS SDK”，但当前公开 demo 是 `armeabi-v7a`，测试手机只支持 `arm64-v8a`，还需要新版/定制 SDK 或换设备验证。 |

参考链接：

```text
https://developerdoc.rokid.com/sdk
https://x-docs.rokid.com/docs/en/代码示例/35-voice-ai/02-眼镜端-TTS-与-ASR.html
https://x-docs.rokid.com/docs/代码示例/35-voice-ai/01-手机端-SDK-初始化（ASR-TTS）.html
https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/RokidAiSdk/RokidAiSdk.html
https://developer.volcengine.com/articles/7561249297782865947
https://zhuanlan.zhihu.com/p/1978589532887736969
https://github.com/zero2005x/RokidAIAssistant
```

因此当前最稳的产品化判断是：

| 问题 | 当前答案 |
| --- | --- |
| 能不能语音说？ | 能，但公开 CXR 路线更稳的是拿音频流后自己 ASR，或走 CXR-M 场景联动；不是直接拿 Rokid AI App 的内部转写文本。 |
| 能不能用 Rokid 原生 ASR 文本？ | 官方 Glass SDK / RokidAiSdk 有对应形态，但当前测试链路还没满足运行条件。 |
| 能不能用 Rokid 原生 TTS？ | Glass SDK 文档有离线 TTS，RokidAiSdk 也有 TTS；但当前 CustomApp bind 失败，RokidAiSdk 又卡 ABI/凭证。Phone SDK 侧已补 AK/SK 配置入口，需真机授权后继续查 `RABI_STATUS`。 |
| 现在应该在 APK 里怎么呈现？ | 把“音频流保存/播放/外部 ASR”作为可用测试项；把“原生 ASR/TTS”标成实验项，并展示 readiness 失败原因。 |

## AK/SK 注入安全边界

历史实测 `com.rokid.security:phone.sdk:2.2.0-E` 在 `initSDK` 内部会向 logcat 打印完整 `EngineParam`，其中包括 `userAuthInfo`。当前 APK 已升级到 `2.5.1-P`，但还没有用真实 AK/SK 做隔离验证；因此仍按同一安全边界处理：APK 可以本机保存 Rokid 在线语音 AK/SK，但不会自动把真实 AK/SK 传给 `EngineParam`，避免真实密钥出现在 logcat。

后续只有满足其中一个条件后才应该打开真实注入：

| 条件 | 说明 |
| --- | --- |
| 官方提供无日志初始化或脱敏配置 | 能确认 `EngineParam(userAuthInfo=...)` 不再打印真实 AK/SK。 |
| 官方提供安全注入方式，或使用一次性测试密钥隔离验证 | `phone.sdk.rfmlite` 构建问题已解决；剩余风险是 SDK 初始化日志会打印 `EngineParam.userAuthInfo`。 |
| 使用一次性测试密钥和隔离设备 | 只用于短时可行性验证，验证后立即吊销密钥并清空手机配置。 |

## `phone.sdk.rfmlite` 构建结论

官方 `glass3sdkdemo/glass3sdkphonedemo` 使用 `com.rokid.security:phone.sdk:2.2.0-E` 时只排除 `org.slf4j`。本地探针把构建工具链升级到 AGP `8.4.2` / Kotlin `1.9.0` / Gradle `8.6` 后，已经可以恢复打包 `phone.sdk.rfmlite`；随后升级到 `phone.sdk:2.5.1-P` 也能 `assembleDebug` 通过。

该包内包含 `assets/rfmlite/`、`assets/rfmvad/`、`librfmlite.so`、`librfm-vad.so`、`librokid_rfm_lite.so` 等资源。升级到 `phone.sdk:2.5.1-P` 后，手机语音入口已经迁移到 `phone.core.ability` 命名空间；当前 APK 环境检查改为验证新版类：

```text
com.rokid.security.phone.core.ability.asr.AsrEngine
com.rokid.security.phone.core.ability.asr.AsrConnectClient
com.rokid.security.phone.core.ability.tts.TtsEngine
com.rokid.security.phone.core.ability.tts.TtsConnectClient
com.rokid.security.phone.core.ability.bean.BaseConfig
com.rokid.security.phone.sdk.server.UrlConfig
com.rokid.security.phone.sdk.base.utils.net.SecuritySDKEnv
```

这只证明手机端 SDK 组件已进入 APK 并可被类加载，不等于原生 ASR/TTS 已闭环。当前剩余硬边界是 Phone SDK 初始化日志/授权安全、ClassicBT 连接、设备媒体/消息通道、`GlassDeviceInfo` 缓存和 `x-app-authorization` readiness。要继续验证真实在线 ASR/TTS，需要官方无日志/脱敏初始化方式，或使用一次性测试密钥在隔离设备上短时验证并立即吊销。

## 本机 Rokid SDK 盘点

2026-07-05 追加 `scripts/Inspect-RokidSdkArtifacts.ps1`，用于扫描本机 Gradle cache、`RokidAiSdkDemo` 和 `app/libs` 里的 Rokid 相关 AAR/JAR，自动列出 native ABI 和 ASR/TTS/RFM 类名线索。这个脚本用于回答一个关键问题：当前本机有没有能替代 `RokidAiSdk 1.4.3` 的 `arm64-v8a` 完整 ASR/TTS artifact。

运行：

```powershell
.\scripts\Inspect-RokidSdkArtifacts.ps1
```

本轮输出：

```text
out/rokid-sdk-artifacts/rokid-sdk-artifacts-summary-20260705-090530.json
out/rokid-sdk-artifacts/rokid-sdk-artifacts-summary-20260705-090530.md
```

结论表：

| Artifact | Native ABI | 语音线索 | 是否能替代完整 ASR/TTS |
| --- | --- | --- | --- |
| `com.rokid.security:phone.sdk.rfmlite:1.0.1-20251212.074206-1` | `arm64-v8a` | `RokidRFMLite`、`RokidRFMVad`、`assets/rfmlite/`、`assets/rfmvad/` | 不能单独替代。公开方法显示 `RokidRFMLite.predict(String...)` 是文本到 NLU/意图，`RokidRFMVad.feed(...)` 是 VAD；不是 PCM 到文本 ASR，也没有 TTS。 |
| `com.rokid.security:phone.sdk.api/server:2.2.0-E` | 无 native | `AsrManager`、`TtsManager`、`ASRRequest.asrInt(...)` | 是当前 Phone SDK 在线 ASR/TTS 管理层，仍依赖授权、连接状态和 SDK 初始化，不是无凭证本地 ASR/TTS。 |
| `basic-1.4.3.aar` / `audioai-1.4.3.aar` / `turenso-1.4.3.aar` | `armeabi-v7a` | `IRokidAudioAiService`、`IRokidAudioAiListener`、`AudioAiService`、`librasr.so`、`librokid_speech_jni.so` | 是最接近完整 ASR/TTS 的 RokidAiSdk 路线，但当前测试手机 `arm64-v8a` only，无法加载。 |
| `com.rokid.ai:aicore*` | 部分有 `arm64-v8a` | face recognizer / AI core 线索 | 不是语音 ASR/TTS 路线。 |

`javap` 复核 `phone.sdk.rfmlite` 的公开方法：

```text
RokidRFMLite.predict(java.lang.String, int, java.lang.String, java.lang.String)
RokidRFMVad.create(...)
RokidRFMVad.start(...)
RokidRFMVad.feed(java.lang.String, java.lang.String)
RokidRFMVad.stop(...)
```

`javap` 复核 Phone SDK ASR/TTS 管理类：

```text
AsrManager.initAsr()
AsrManager.onAsrMethod(AsrExtra)
AsrManager.onAudioStream(byte[], int)
TtsManager.initTts()
TtsManager.onTtsMethod(TtsExtra)
TtsManager.onAudioStream(byte[], int)
```

所以当前可执行判断是：本机确实已有 `arm64-v8a` 的 RFM/VAD/离线意图组件，但没有发现 `arm64-v8a` 的完整 RokidAiSdk AudioAi ASR/TTS artifact。后续如果 Gradle cache 或官方包里新增 `arm64-v8a` 的 `basic/turenso/audioai` 或等价语音 AAR，先跑 `Inspect-RokidSdkArtifacts.ps1` 和 `Test-RokidAiSdkAbi.ps1`，再进入 APK 真机验证。

## Phone SDK 2.5.1-P 升级实验

2026-07-05 继续查询 Rokid Maven metadata 后，发现以下较新的 release：

| Artifact | 旧版本 | 新版本 | 本地处理 |
| --- | --- | --- | --- |
| `com.rokid.security:phone.sdk` | `2.2.0-E` | `2.5.1-P` | 已升级并适配编译。 |
| `com.rokid.security:glass3.open.sdk` | `2.2.0-E` | `2.5.1-P` | 已升级；`SpeechCallback` 新版只保留 `onStart/onIntermediateVad/onAsrComplete/onError` 四个 override。 |
| `com.rokid.cxr:client-l` | `1.0.4` | `1.1.0` | 已升级；`ICXRLinkCbk` 新增 `onGlassLauncherResume()`，APK 已补回调。 |

迁移后类名变化：

| 旧类 | 新类 |
| --- | --- |
| `com.rokid.security.sdk.ability.asr.AsrEngine` | `com.rokid.security.phone.core.ability.asr.AsrEngine` |
| `com.rokid.security.sdk.ability.tts.TtsEngine` | `com.rokid.security.phone.core.ability.tts.TtsEngine` |
| `com.rokid.security.sdk.ability.bean.BaseConfig` | `com.rokid.security.phone.core.ability.bean.BaseConfig` |
| `com.rokid.security.sdk.ability.net.SecuritySDKEnv` | `com.rokid.security.phone.sdk.base.utils.net.SecuritySDKEnv` |
| `com.rokid.security.sdk.ability.net.UrlConfig` | `com.rokid.security.phone.sdk.server.UrlConfig` |
| `com.rokid.security.sdk.ability.auth.UserManager` | `com.rokid.security.phone.sdk.server.usercenter.UserManager` |

新版仍保留手机侧在线语音入口：

```text
AsrEngine.init(BaseConfig, AsrConnectClient.AsrListener)
AsrEngine.startSpeech()
AsrEngine.doSpeechVoice(byte[])
TtsEngine.init(BaseConfig, TtsConnectClient.TtsListener)
TtsEngine.playTts(String)
```

但真机前置条件没有改善：

```text
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-102313.json
readyForPhoneVoice=false
btConnected=false
deviceLinkLine="scan fallback to bonded candidates"
p2pServicePresent=true
p2pConnected=false
p2pReadyForDeviceMedia=false
deviceInfoPresent=false
deviceIdReady=false
authReady=false
handshakeTimedOut=true
videoAudioVideoSeen=false
videoAudioAudioSeen=false
videoAudioHandshakeLine="reason=video timeout video=false audioRequested=false audio=false"
btConnectLine="success=false target=name=Glasses_3268 addressSuffix=45:55"
p2pLine="service=true connected=false peers=0 matchedPeer=false readyForDeviceMedia=false"
```

结论：`2.5.1-P` 适合保留，因为它是当前公开 Maven 上更近的 Phone/Glass SDK 且 APK 已能构建安装；但它没有自动解决第三方 APK 接管 Rokid AI App 已有连接、建立 Phone SDK ClassicBT/P2P 设备媒体与消息通道、获取 `GlassDeviceInfo`、生成在线语音 app token 的问题。已补齐并复测 Android 位置权限后，P2P 仍未 ready；进一步压缩官方 DeviceLinker 流程后，ClassicBT scan 也没有发现 Glass/Rokid 候选。因此后续重点应转向眼镜端如何进入官方 Phone SDK 可发现/可配对状态，或确认第三方 APK 是否被允许复用 Rokid AI App 的已配对关系。

2026-07-05 继续补官方示例里的 Android 系统关联外层：`UuidDeviceDiscoveryManager` 实际使用 `CompanionDeviceManager + BluetoothDeviceFilter.setAddress(address)` 对指定 ClassicBT 地址发起系统 association，而不是纯 UUID 后台扫描。APK 已新增交互式 `phone_companion_associate` / `系统关联眼镜` 探针：从 bonded 设备中选择 Rokid/Glass 候选，打开 Android 系统关联界面；关联成功后调用 `startObservingDevicePresence(address)`，再自动回跑 `phone_device_link_probe` 和 `phone_bt_auth`。这条路线只验证“是否缺少系统 Companion 关联前置”，不把它计入无人值守 prerequisites。

复测记录：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-103415.txt
out/rokid-native-voice/rokid-native-command-filtered-20260705-103536.txt
out/rokid-native-voice/rabi-ui-after-companion.xml
```

第一次触发时系统报错 `Must declare uses-feature android.software.companion_device_setup in manifest to use this API`，已在 manifest 增加 `android.software.companion_device_setup` 且 `required=false`。第二次触发已进入 `Phone SDK Companion association pending; launching chooser target=name=Glasses_3268 addressSuffix=45:55`，并且 `dumpsys activity` 显示前台 activity 是 `com.android.companiondevicemanager/.CompanionAssociationActivity`；但当时手机处于锁屏状态，UI dump 显示“请用图案密码或指纹解锁”，所以尚未拿到用户确认后的 `onActivityResult` / `onAssociationCreated`。

后续补了只读状态脚本：

```powershell
.\scripts\Get-RokidCompanionAssociationState.ps1 -Serial <adb-serial>
```

当前只读结果：

```text
status=waiting_unlock
topActivity=com.android.companiondevicemanager/.CompanionAssociationActivity
associationActivityVisible=true
waitingForUserUnlock=true
associationPending=true
associationCreated=false
deviceLinkSeen=false
btAuthSeen=false
summaryPath=out/rokid-native-voice/rokid-companion-state-summary-20260705-104229.json
```

注意：如果系统关联页已在前台但手机仍锁屏，不要重复运行 `phone_companion_associate`；重复触发会让本次 association 回调 `failure=canceled`，但前台系统确认页可能仍然存在。正确流程是先解锁手机并确认关联，再用只读状态脚本确认是否进入 `associated` 或是否出现 `Phone SDK Companion association result/created`，最后运行 `Test-RokidPhoneVoicePrerequisites.ps1 -IncludeBtConnect` 比较 Phone SDK readiness。

同日继续用系统调试入口验证“是否只是缺少 `com.rabi.link` 的系统 association”。手机 `dumpsys companiondevice` 里已有 Rokid AI App 对 `Glasses_3268` 的 association；新增脚本会读取该 association，只把同一眼镜地址注册给 `com.rabi.link`，输出只保留地址后缀：

```powershell
.\scripts\Register-RokidCompanionAssociation.ps1 -Serial <adb-serial>
```

证据：

```text
out/rokid-native-voice/rokid-companion-register-summary-20260705-105209.json
out/rokid-native-voice/rokid-native-command-filtered-20260705-104737.txt
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-105028.json
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-105507.json
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-110713.json
```

结果：`com.rabi.link` association 已存在，补 `android.permission.REQUEST_OBSERVE_COMPANION_DEVICE_PRESENCE` 后 `phone_device_link_probe` 能记录 `Phone SDK Companion observing presence addressSuffix=45:55`。最新总检查里 `companionObserved=true`，但 Phone SDK ClassicBT 仍然 `classicConnected=false`，`connect callback source=bonded success=false`，`GlassDeviceInfo present=false`，P2P 仍 `readyForDeviceMedia=false`。因此 Companion association/observe 已经不是当前主要缺口；当前缺口收敛到 Phone SDK 私有 ClassicBT message/auth 通道没有连接，系统 A2DP/Companion association 不能替代这条通道。

继续对照官方 sample 后，新增 `phone_system_info_probe`：按 `DeviceLinkerManager.getGlassSystemInfoMsg()` 的思路，向 `RokidESecurity` 发送 `{"type":"GET_SYSTEM_INFO","message":""}`，并等待 `SYSTEM_INFO_RESPONSE`。当前真机 API 调用层显示 ClassicBT/P2P 两路都已发起请求，但 5 秒内没有收到响应：

```text
Phone SDK official system info requested classic=true p2p=true clientId=RokidESecurity payload={"type":"GET_SYSTEM_INFO","message":""}
Phone SDK official system info timeout after 5000ms; check ClassicBT/P2P message callbacks
Phone SDK BT/Auth probe sdkInit=true classicService=true classicConnected=false message=false audio=false file=false stream=false deviceAuth=false readyForDeviceMessages=false
Phone SDK glass device info probe present=false deviceId=false/0 deviceType=false deviceSubType=false btMac=false wifiMac=false p2pMac=false osVersion=false readyForAppToken=false
```

这条证据比单纯 P2P/视频音频握手更靠近官方 demo 的主流程：官方示例拿系统信息和后续 `GlassDeviceInfo` 都依赖同一类设备消息通道。当前没有 `SYSTEM_INFO_RESPONSE`，所以后续在线 ASR/TTS 仍不能视为 ready。

## 手机侧 Phone SDK 语音引擎探针

2026-07-05 已在 `com.rabi.link` 中新增手机侧 Rokid Phone SDK 语音引擎探针，不再只等待眼镜端 CustomApp 的 `GlassSdk` 服务：

| 探针 | 调用 | 当前真机结果 |
| --- | --- | --- |
| Phone SDK 眼镜设备信息 | 读取 `PSecuritySDK.getAbsDeviceInfoService()?.getGlassDeviceInfo()` | 新增 `phone_device_info` / `phone_glass_device` 命令，单独输出 `deviceId/deviceType/mac/osVersion` 的存在性和长度，不打印设备 ID 或 MAC 原值。 |
| Phone SDK 官方连接探针 | 压缩官方 `ClassicBtActivity -> BtWifiConnectActivity -> DeviceLinkerManager`：ClassicBT scan 找 Glass/Rokid 候选，失败后回退 bonded，BT 成功后再探 P2P | 已接入 `phone_device_link_probe`；补 association/observe 后仍然 scan 不到 Glass/Rokid，回退 bonded `Glasses_3268` 后 `connect callback source=bonded success=false`。 |
| Phone SDK 系统 Companion 关联 | 按官方 `UuidDeviceDiscoveryManager` 思路用 `CompanionDeviceManager` 对 bonded 眼镜地址发起系统 association，成功后观察 presence 并回跑连接探针 | 已接入 `phone_companion_associate`、只读 `Get-RokidCompanionAssociationState.ps1` 和调试注册 `Register-RokidCompanionAssociation.ps1`；当前 `com.rabi.link` association 已存在，`startObservingDevicePresence` 已成功，但 Phone SDK BT/P2P readiness 未因此变 ready。 |
| Phone SDK 官方系统信息消息 | 发送官方 sample 同款 `GET_SYSTEM_INFO` 到 `RokidESecurity`，等待 `SYSTEM_INFO_RESPONSE` 和 `custom_business_action` | 已接入 `phone_system_info_probe`；当前 ClassicBT/P2P 请求已发出但超时，无 `SYSTEM_INFO_RESPONSE`，并且 `classicConnected=false;message=false;deviceAuth=false`。 |
| 手机语音授权 readiness | 读取 `SecuritySDKEnv.headers`，并用 `x-app-authorization` 是否存在代表当前 app authorization readiness | 2026-07-05 真机结果：`configured=false sdkAppAuth=false xUser=false/0 xApp=false/0 appCredential=false/0 userCredential=false/0 glassDeviceInfo=false glassDeviceId=false ready=false`。输出只包含存在性和长度，不打印 token/AK/SK。 |
| 初始化手机语音 | `AsrEngine.init(BaseConfig(WS_ASR), listener)` + `TtsEngine.init(BaseConfig(WS_TTS), listener)` | 能发起连接，endpoint 为 `wss://api.rokid.com/ar/audio/api/ws/asr/streaming` 和 `wss://api.rokid.com/ar/audio/api/ws/tts`。 |
| 手机 ASR 喂音频 | `AsrEngine.startSpeech()` + CXR 音频流 PCM 旁路到 `AsrEngine.doSpeechVoice(byte[])` | 代码路径已接通；未通过 readiness 时 UI 隐藏按钮，ADB 命令直接记录 not ready，不进入 WebSocket。 |
| 手机 TTS 测试 | `TtsEngine.playTts(text)`，监听 TTS 音频字节和完成回调 | 未通过 readiness 时 UI 隐藏按钮，ADB 命令直接记录 not ready；不再把必然失败的连接当作正常测试。 |
| Phone SDK P2P 探针 | `isConnect` -> `sendConnectP2pRequest` -> `initialize/startDiscoverPeers` -> 匹配 peer 后 `connectDevice` | 已接入 `phone_p2p_probe`；当前真机 service 可用但 `connected=false`、`peers=0`、`groupFormed=false`、`groupInfo=false`，`keepConnect` 返回“蓝牙未连接，请先连接上蓝牙”。 |
| Phone SDK 视频+音频握手 | 按官方 demo 顺序先请求视频流，收到首帧后再请求音频流 | 已接入 `phone_device_video_audio_handshake`；当前真机 10 秒内无首个视频包，因此没有进入 audio 阶段。 |
| 超时清理 | `phone_*` 命令 7 秒无回调后销毁 engine | 历史无授权直连已验证 `Phone SDK ASR/TTS probe destroyed`；当前默认先 readiness 拦截。 |

2026-07-05 继续反查 SDK 字节码后，新增一条更安全的授权激活路线：

| 发现 | 证据 | 当前实现 |
| --- | --- | --- |
| `initSDK(param)` 会打印 `EngineParam.toString()` | `MobileEngineServerImpl.initSDK()` 里直接拼接 `initSDK: EngineParam = ` + `param`；`UserAuthInfo.toString()` 会输出 `appId` 和 `secret`。 | 仍保持 `EngineParam.UserAuthInfo("", "")`，不把真实 AK/SK 传入该入口。 |
| `initRKLogger()` 会把 `L.filterLevel` 改回 2 | 所以初始化前 `L.setTAG("Mobile-SDK", 6)` 会被覆盖。 | 初始化回调后再次调用 `L.setTAG("Mobile-SDK", 6)`，用于压住后续 SDK header/token 日志。 |
| SDK 官方 `GenerateSignedToken.generateSignedToken()` 也会打印 `secretKey` | 字节码里 `updateHeaders generateSignedToken ... secretKey:` 直接进入 `L.i(...)`。 | 不调用该生成器；在 `com.rabi.link` 内用 Auth0 JWT 自己生成同结构 HS256 app token。 |
| `DeviceInfoManager` 会从 `DEVICE_INFO` 消息缓存 `GlassDeviceInfo` | `getAbsDeviceInfoService().getGlassDeviceInfo()` 可返回 `deviceId/deviceType/btMac/wifiMac/p2pMac/osVersion`。 | 新增 `phone_device_info` 单独探针；`phone_auth_apply` 只有在 AK/SK 和 `GlassDeviceInfo.deviceId` 都存在后，才生成 app token 并调用 `SecuritySDKEnv.updateDeviceHeaders(...)`。 |

当前真机未连接/未配置环境下的新证据：

```text
Phone SDK voice auth probe configured=false sdkAppAuth=false xUser=false/0 xApp=false/0 appCredential=false/0 userCredential=false/0 glassDeviceInfo=false glassDeviceId=false ready=false
Phone SDK glass device info probe present=false deviceId=false/0 deviceType=false deviceSubType=false btMac=false wifiMac=false p2pMac=false osVersion=false readyForAppToken=false
Phone SDK voice auth apply skipped: AK/SK not configured
```

2026-07-05 进一步验证：即使 `connect_glass_app` 已经让 CXR CustomApp 会话变为 ready，Phone SDK 设备服务仍不会自动拿到 `GlassDeviceInfo`：

```text
connectGlassAppSession=true
onCXRLConnected=true
onGlassAppSessionAvailable reason=SESSION_LINK_CONNECT
Phone SDK device audio handshake requested tag=RabiPhoneDeviceInfoProbe
Phone SDK device audio handshake timeout after 5000ms
Phone SDK glass device info probe present=false deviceId=false/0 deviceType=false deviceSubType=false btMac=false wifiMac=false p2pMac=false osVersion=false readyForAppToken=false
```

结论：CXRLink 的 CustomApp/CustomView 会话和 Phone SDK 内部 `RokidESecurity` 设备服务通道不是同一个 readiness。当前 `phone_device_handshake` 能证明 `requestAudioStream(tag)` 请求已发出，但没有收到 `AUDIO_STREAM_RESP` 回调，也没有触发 `DEVICE_INFO` 缓存。下一步应继续查 Phone SDK 初始化后如何建立/绑定 `RokidESecurity` 这一侧的系统消息通道，而不是继续堆 CXR 会话按钮。

这说明下一步真实闭环不再卡在“只能把 AK/SK 放进 EngineParam”这一条路，而是需要同时满足：

1. 本机配置一次性/正式 AK/SK。
2. `phone_device_info` 显示 Phone SDK 已通过连接消息拿到 `GlassDeviceInfo.deviceId`。
3. `phone_auth_apply` 后 readiness 变为 `ready=true`。
4. 再运行 `phone_tts` 或 `phone_asr_start` 验证是否从 not ready 进入真实 ASR/TTS 回调。

历史无真实授权直连时，服务端返回：

```text
WebSocket连接失败 - Expected HTTP 101 response but was '200 OK'
```

这说明手机侧 SDK 路线是存在的，但握手需要完整授权/业务头。由于 `EngineParam.userAuthInfo` 日志泄漏问题还没解决，当前 APK 仍不会自动注入真实 AK/SK。下一步要么拿官方脱敏初始化方式，要么用一次性测试密钥在隔离设备上短时打开注入并吊销。
