# Rokid 原生 ASR/TTS 接入说明

<!-- docs-language-switch -->
<div align="center">
<a href="./rokid-native-asr-tts_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

> 状态：实验取证账本，最近集中结论为 2026-07-05。文中大量命令记录调查过程，不应被当成当前已支持的安装流程。

本文记录 `com.rabi.link` 里 Rokid 原生 ASR/TTS 探针的当前协议、测试入口和真机验收口径。

最新的官方文档、论坛证据和通讯方式总结见 `docs/rokid-asr-tts-communication-research.md`。该文档把 OpenVoice/RokidAiSdk、Glass SDK、CXR-M/CXR-L 和外部 ASR/TTS 四条路线分开，避免把 CXR 授权 token、`.lc` 授权文件和 RokidAiSdk 五段语音凭证混用。

## 目标

当前目标不是只采集眼镜麦克风 PCM/WAV，而是验证眼镜端 Glass SDK 是否可以直接给出“用户说了什么”的文本，并验证眼镜端 TTS 是否可以由手机侧触发播报。

实现采用一个手机 APK：

- 手机 APK：`com.rabi.link`
- 内置眼镜测试 APK：`com.rabi.link.glass`
- 手机端通过 CXR-L CustomApp 会话安装/启动眼镜 APK。
- 手机端通过 Rokid Phone Security SDK MessageService 给眼镜 APK 发文本命令。
- 眼镜端通过 Glass SDK 调用 ASR/TTS，并把结果或错误回传给手机。

## 中文资料结论

已查到的中文资料给出的边界是：

| 资料 | 能确认的能力 | 对本探针的含义 |
| --- | --- | --- |
| Rokid 语音 SDK 使用文档 | RokidAiSdk 面向 Android APK 集成，覆盖 speech、云端语义识别返回和 TTS 能力；需要在开放平台创建产品并取得 `Key` / `Secret` / `deviceTypeId` / `deviceId(sn)` / `seed` 等授权信息。 | 这是完整 ASR/TTS 的正式 SDK 路线，但不是当前 CXR-L CustomApp 示例里直接暴露的零配置接口。 |
| Rokid ASR 文档 | ASR 能把语音转换成文本，支持中英混合、流式结果和热词/句式优化。 | 证明 Rokid 平台有文本 ASR 能力；是否能在本眼镜 CustomApp 里直接调用，要以眼镜端 APK 真机回包为准。 |
| 中文社区 CXR-M AI 助手实践 | 社区实现把 ASR、AI、TTS 放在手机业务侧，CXR-M 负责 AI 按键、`sendAsrContent`、`sendTtsContent`、拍照和错误状态推送；文章明确提到 SDK 不提供语音识别引擎、AI 大模型服务和 TTS 合成。 | 进一步支持当前判断：CXRLink/AI 场景本身不是“直接返回用户说了什么”的 ASR API，它更像眼镜显示和交互通道。 |
| CXR-M 提词器 AI 模式文章 | 提词器场景可以通过 ASR 内容驱动自动跟踪/滚动，社区文章把 `sendAsrContent()` 描述为 AI 模式联动入口。 | 说明 CXR-M 生态里存在“语音文本 -> 眼镜场景”的路径；但它偏提词器场景，不等同于 CXR-L 音频流直接返回用户说了什么。 |

凭证来源也有官方资料：RokidAiSdk 文档的“设备注册/校验机制”说明，`Key`、`Secret`、`deviceTypeId` 来自 Rokid 开放平台语音接入产品；`deviceId(sn)`、`seed` 是设备侧测试/认证信息，不应从 App 反编译获得。官方资料链接：

- <https://open.rokid.com/>
- <https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/RokidAiSdk/RokidAiSdk.html>
- <https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/rookie-guide/rookie-guide-end.html>

实际申请时先在开放平台控制台点“创建应用”，找“语音接入 / RokidAiSdk / AI 语音 / 语音 SDK”入口。能创建语音产品后再取 `Key`、`Secret`、`deviceTypeId`，并到设备/SN 管理里申请测试 `deviceId(sn)` 和 `seed`。如果当前账号后台没有这个入口，就需要联系 Rokid 开发者支持或商务开权限。

当前实现仍按最小可验证路线推进：先用内置眼镜 APK 调 Glass SDK ASR/TTS，手机只负责安装/启动眼镜 APK、发 `RABI_*` 命令和收回包。不能把 `获取眼镜端音频` 直接当作 `获取用户说的话`，除非真机收到 `RABI_ASR:<text>` 或官方 SDK 明确返回文本。

## 2026-07-05 真机结论

本轮已把手机 APK 和内置眼镜测试 APK 都装到真机链路上验证。结论是：CXR-L CustomApp、自定义眼镜 GUI、CXR CustomCmd 双向消息可用；但眼镜测试 APK 内调用 `GlassSdk` 时，原生 ASR/TTS 服务当前不可用，不能把它标为已完成的原生语音闭环。

| 完成状态 | 能力/问题 | 真机结果 | 证据 |
| --- | --- | --- | --- |
| 已完成 | 手机 APK `com.rabi.link` 安装 | `adb install -r app-debug.apk` 成功 | `app/build/outputs/apk/debug/app-debug.apk` |
| 已完成 | Rokid CustomApp 会话 | `connect_glass_app` 返回 `customAppReady=true` | `out/rokid-native-voice/rokid-glass-app-command-summary-20260705-044825.json` |
| 已完成 | 眼镜 APK 安装/启动 | 保持手机 Awake 后 `onInstallAppResult=true`，`onOpenAppResult=true` | `rokid-glass-app-command-summary-20260705-044836.json`、`rokid-glass-app-command-summary-20260705-044938.json` |
| 已完成 | 自定义应用/GUI 可运行 | 眼镜 APK 能启动，`RABI_PING` 有回包 | `rokid-native-command-summary-20260705-044313.json` |
| 已完成 | CXR CustomCmd 双向桥 | 手机 `sendCustomCmd` 成功，眼镜回 `RABI_PONG` / `RABI_STATUS` | `rokid-native-command-filtered-20260705-044955.txt` |
| 已验证为当前不可用 | Glass SDK ready 状态 | 眼镜回 `RABI_STATUS:ready=false;asr=false;tts=false;message=false`，20 秒后复查仍相同 | `rokid-native-command-filtered-20260705-045114.txt` |
| 已定位 | Glass SDK 绑定缺口 | 增强诊断回 `serverPackage=false;bindRequested=true;serviceConnected=false;registerRequested=false;clientReady=false`，说明眼镜 CustomApp 运行环境里看不到 `com.rokid.security.system.server`，`bindSecurityService` 没有进入 `onServiceConnected` | `rokid-native-command-filtered-20260705-050238.txt` |
| 未完成 | 原生 ASR 文本 | `asr_start` 回 `RABI_ASR_START_ERR:glass_sdk_not_ready`，没有 `RABI_ASR:<text>` | `rokid-native-command-filtered-20260705-045018.txt` |
| 未完成 | 原生 TTS 播报 | `tts` 回 `RABI_TTS_ERR:glass_sdk_not_ready`，没有 `RABI_TTS_OK:<text>` | `rokid-native-command-filtered-20260705-045007.txt` |

安装注意事项：`appUploadAndInstall` 对手机前台/电源状态敏感。手机进入 Dozing 时多次出现 `CXRLinkService: 加入热点失败` 和 `onInstallAppResult=false`；用 ADB 设置 `settings put global stay_on_while_plugged_in 7` 并保持 Awake 后安装成功。已新增 `scripts/Install-RokidGlassAsrWithRetry.ps1`，用于自动执行保持唤醒、重连 CustomApp、安装眼镜 APK 和失败重试。

当前判断：CXR-L CustomApp 示例链路可以作为“眼镜端自定义 UI + 双向控制消息”的桥，但当前这台乐奇眼镜的 CustomApp 环境没有暴露 `com.rokid.security.system.server`，所以不能直接调用 Glass3 SDK 的原生 ASR/TTS。要继续做真正“用户说了啥”的文本入口，需要改走 RokidAiSdk 正式语音 SDK 授权路线，或找到 Rokid 文档/社区明确支持 CustomApp 内安装/启用 Glass Security Service 的前置条件。

2026-07-05 继续按官方眼镜端语音文档补了 `GlassOfflineCmdService` 离线指令探针：眼镜端新增 `RABI_OFFLINE_CMD_ARM` / `RABI_OFFLINE_CMD_CLEAR`，手机端新增 `offline_cmd_arm` / `offline_cmd_clear`，固定注册 `测试中文`、`打开Rabi`、`关闭Rabi` 三个 Hello World 级别词条。真机结果仍然收敛到同一个前置条件：`status` 回 `offlineCmd=false;offlineArmed=false`，注册离线指令回 `RABI_OFFLINE_CMD_ERR:glass_sdk_not_ready`。

这条证据很重要：离线语音指令不是绕过 ASR/TTS 的备用通道，它同样依赖当前 CustomApp 环境里不可用的 Glass SDK Security Service。因此它不能作为“直接拿到用户说了什么”的文本入口，也不能作为当前原生 ASR/TTS 完成口径。

同日追加了另一条绕开 Glass SDK 的眼镜端探针：在内置眼镜 APK 里直接调用 Android 系统 `SpeechRecognizer` / `TextToSpeech`，协议为 `RABI_GLASS_ANDROID_*`。眼镜 APK 升到 `versionCode=4` 后重新安装并启动成功，CXR CustomCmd 回包正常，但眼镜端系统语音同样不可用：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-114825.txt
RABI_GLASS_ANDROID_STATUS:recordAudioGranted=true;speechRecognizer=false;asrListening=false;ttsReady=false;event=tts_not_ready;error=tts_not_ready
```

补充启动测试：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-114604.txt
RABI_GLASS_ANDROID_ERR:asr:speech_recognizer_unavailable
RABI_GLASS_ANDROID_ERR:tts:tts_not_ready
```

这说明当前眼镜 CustomApp 内没有可用的 Android 系统识别服务，系统 `TextToSpeech` 也没有 ready。于是“眼镜端直接拿文本”的三条本地路线都已收敛：Glass SDK ASR/TTS 不 ready，GlassOfflineCmd 不 ready，Android 系统 ASR/TTS 也不 ready。

2026-07-05 继续补手机侧 Android 系统语音的蓝牙路由探针。新增 `android_voice_route_bluetooth` / `android_voice_clear_bluetooth`，实现上先尝试 Android 12+ `AudioManager.setCommunicationDevice(TYPE_BLUETOOTH_SCO/BLE_HEADSET)`，失败再回退 `startBluetoothSco()`。当前真机结果：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-115529.txt
Android system voice probe ... inputs=6[...] outputs=3[...] bluetoothRouteRequested=false communicationDevice=TYPE_1:systemDevice communicationDevices=TYPE_1:systemDevice,BUILTIN_SPEAKER:systemDevice

out/rokid-native-voice/rokid-native-command-filtered-20260705-115558.txt
Android system voice Bluetooth route requested routed=false target=none;scoOn=false communicationDevice=TYPE_1:systemDevice communicationDevices=TYPE_1:systemDevice,BUILTIN_SPEAKER:systemDevice
```

结论：手机系统 ASR/TTS 本身可用，但当前这次测试里，乐奇眼镜没有作为 APK 可选的蓝牙通信设备暴露给 `AudioManager`，主动请求 SCO 也没有拉起 `bt_sco`。因此“手机系统 ASR/TTS + 眼镜蓝牙麦克风/扬声器”暂时也不能当作已闭环路线。

同日继续补 `BluetoothHeadset.startVoiceRecognition(BluetoothDevice)` 探针，目标是确认能不能把眼镜当作系统 HFP/HEADSET 语音输入设备主动拉起。APK 新增 `android_headset_voice_start` / `android_headset_voice_stop`，会先取 `BluetoothProfile.HEADSET` proxy，再从 connected devices 里找 `Rokid/Glass/Glasses`，没有 connected 目标时只把 bonded 设备作为诊断兜底。真机结果：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-120536.txt
Android Bluetooth HEADSET profile proxy requested=true
Android Bluetooth HEADSET voice recognition requested=false target=name=Glasses_3268 addressSuffix=45:55 source=bonded headsetState=disconnected connected=none

out/rokid-native-voice/rokid-native-command-filtered-20260705-120701.txt
Android system voice Bluetooth route requested routed=false target=none;scoOn=false
```

结论：手机系统确实能看到已配对的 `Glasses_3268`，但它当前不是 `BluetoothHeadset.getConnectedDevices()` 返回的 connected HFP 设备，`getConnectionState` 为 `disconnected`，所以第三方 APK 不能用 `startVoiceRecognition()` 拉起眼镜麦克风语音通道。这进一步收窄了边界：已配对/可被 CXR 使用，不等于 Android 系统语音或 HFP 语音链路可被 `com.rabi.link` 接管。

2026-07-05 继续把眼镜端 `RABI_STATUS` 扩展为 ABI 诊断，眼镜 APK 升到 `versionCode=5` / `0.1.4` 后重新安装并启动成功。`diag` 回包显示：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-121528.txt
device=Rokid/RG-glasses/sdk32
supportedAbis=arm64-v8a,armeabi-v7a,armeabi
supported32BitAbis=armeabi-v7a,armeabi
supported64BitAbis=arm64-v8a
nativeLibraryDir=/data/app/.../com.rabi.link.glass.../lib/arm64
androidVoice=recordAudioGranted=true,speechRecognizer=false,asrListening=false,ttsReady=false,event=tts_init_failed,error=status=-1
```

这条证据把 RokidAiSdk 的 ABI 判断拆开了：当前手机 `<adb-serial>` 只有 `arm64-v8a`，所以官方 1.4.3 `armeabi-v7a` 语音 SDK 不适合放在手机 APK 内验证；但眼镜端同时支持 `armeabi-v7a` 和 `arm64-v8a`，因此“把官方 RokidAiSdk 作为眼镜端独立语音探针”在 ABI 层面存在继续实验的可能。它仍不等于已闭环，因为还需要官方 SDK 资产、开放平台凭证和眼镜端启动服务权限；同时当前眼镜端 Android 系统 `SpeechRecognizer` / `TextToSpeech` 仍然不可用。

随后把眼镜端测试 APK 强制为 32 位进程：`glass-app` 增加 `ndk { abiFilters "armeabi-v7a" }`，版本升到 `versionCode=6` / `0.1.5`。重新构建、安装、启动后，CXR CustomCmd 仍能收到 `RABI_STATUS`，并且 native 目录已经切到 32 位：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-122204.txt
supported32BitAbis=armeabi-v7a,armeabi
nativeLibraryDir=/data/app/.../com.rabi.link.glass.../lib/arm
```

这证明“32 位眼镜 APK + CXR CustomCmd 桥”可以同时成立。后续如果要继续试官方 RokidAiSdk，优先在这个 32 位眼镜 APK 里做可选探针，而不是继续在 arm64-only 手机 APK 里硬跑 `armeabi-v7a` 语音库。

2026-07-05 继续把官方 `RokidAiSdkDemo` 的四个 1.4.3 AAR 和 `workdir_asr_cn` ASR 资产接入眼镜端 32 位 APK，并新增眼镜端 `RABI_GLASS_ROKID_AI_*` 命令：

| 命令 | 回包/行为 |
| --- | --- |
| `RABI_GLASS_ROKID_AI_PROBE` | 回 `RABI_ROKID_AI_STATUS:<readiness>`。 |
| `RABI_GLASS_ROKID_AI_CONFIG_B64:<json>` | 把 RokidAiSdk 五段凭证和工作目录写进眼镜 APK 的运行时内存；本项目日志只显示 `<redacted>`。 |
| `RABI_GLASS_ROKID_AI_CLEAR_CONFIG` | 清空眼镜 APK 内存中的 RokidAiSdk 配置。 |
| `RABI_GLASS_ROKID_AI_START` | readiness 通过后启动 `AudioAiConfig.getIndependentIntent(...)` 服务；当前无凭证时返回 `RABI_ROKID_AI_ERROR:not_ready:<readiness>`。 |
| `RABI_GLASS_ROKID_AI_STOP` | 停止服务、解绑 binder、释放录音线程。 |
| `RABI_GLASS_ROKID_AI_TTS:<text>` | 服务连接后调用 `IRokidAudioAiService.playTtsVoice(text)`；当前服务未连接时返回 `tts_not_ready`。 |

真机 readiness 已通过 CXR CustomCmd 回到手机：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-123846.txt
RABI_ROKID_AI_STATUS:assets=true;nativeAbi=true;requiredNativeAbi=armeabi-v7a;device32BitAbis=armeabi-v7a,armeabi;device64BitAbis=arm64-v8a;recordAudioPermission=true;credentials=configured=false;missing=key,secret,deviceTypeId,deviceId,seed;workDir=workdir_asr_cn;configFile=lothal_single.ini;serviceConnected=false;bound=false;recording=false
```

随后故意执行无凭证启动：

```text
out/rokid-native-voice/rokid-native-command-filtered-20260705-123908.txt
RABI_ROKID_AI_ERROR:not_ready:assets=true;nativeAbi=true;recordAudioPermission=true;credentials=configured=false;missing=key,secret,deviceTypeId,deviceId,seed
```

结论：眼镜端 RokidAiSdk 路线已经越过“32 位 ABI、AAR 打包、ASR assets、CXR 消息桥、录音权限”这些前置门槛；当前没有继续启动是正确的安全门控，因为缺开放平台 `key/secret/deviceTypeId/deviceId/seed`。拿到私有测试凭证后，下一步应通过不落仓库的命令注入眼镜端配置，再验证是否能收到 `RABI_ROKID_AI_ASR:<text>` 和 `RABI_ROKID_AI_TTS_REQUEST:<text>`。

2026-07-05 继续补了“钥匙插槽”：新增 `scripts/Set-RokidGlassAiSdkConfig.ps1`。默认读取已被 `.gitignore` 排除的 `secrets/rokid-ai-sdk.properties`，再调用 `glass_rokid_ai_save_config` 把配置发到眼镜端。随后又把同一组字段补到手机 APK 测试页：第 09 卡片填写并保存 RokidAiSdk 五段凭证，第 07 卡片在眼镜 APK 启动后点击“发送眼镜 AI 配置”，即可把配置发给眼镜端。

```properties
key=...
secret=...
deviceTypeId=...
deviceId=...
seed=...
workDir=workdir_asr_cn
configFile=lothal_single.ini
```

```powershell
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -CreateTemplate
.\scripts\Test-RokidGlassAiSdkReadiness.ps1
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -Serial <adb-serial> -ProbeAfter
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -Serial <adb-serial> -StartAfterConfig
.\scripts\Set-RokidGlassAiSdkConfig.ps1 -Serial <adb-serial> -Clear
```

审核通过后推荐直接跑完整试跑脚本：

```powershell
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -ProbeOnly
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial>
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -ConfirmHeardTts
```

该脚本当前在无凭证状态会安全停在 `waiting_credentials`，只提示等待 Rokid 审核或补齐本机配置；不会继续启动眼镜端 RokidAiSdk。

如果凭证是填在手机 APK 第 09 卡片里，而不是写入本机 `secrets/rokid-ai-sdk.properties`，先在第 07 卡片点“发送眼镜 AI 配置”，再让脚本跳过本机配置发送：

```powershell
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -SkipConfigSend -ProbeOnly
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -SkipConfigSend
.\scripts\Run-RokidGlassAiSdkTrial.ps1 -Serial <adb-serial> -SkipConfigSend -ConfirmHeardTts
```

`-ProbeOnly` 只做配置/状态探测和证据收集，不启动 SDK、不发 TTS；确认 readiness 后再去掉它执行完整试跑。

大白话：现在不是“没有地方填 key”，而是“还没有真实 key”。用户已在 Rokid 开放平台提交账号认证/审核；审核通过后，如果后台给出语音接入产品和设备/SN 凭证，可以直接在手机 APK 测试页填写，也可以用 `secrets/rokid-ai-sdk.properties` 走脚本。`Test-RokidGlassAiSdkReadiness.ps1` 会告诉你 APK 是否已构建、私有配置是否完整、最近一次眼镜侧 RokidAiSdk 命令有没有回包。脚本只避免把 key 写进仓库、stdout 和本项目日志；底层仍经过 ADB intent extras 与 CXR CustomCmd，不是强加密密钥通道。

2026-07-05 复查眼镜端 APK 的 merged manifest 后，确认 `glass3.open.sdk` 已合入 Android 11+ 包可见性声明：

```xml
<queries>
    <package android:name="com.rokid.security.system.server" />
</queries>
```

因此 `serverPackage=false` 不能再简单归因于测试 APK 漏写 `<queries>`；更可能是当前 CustomApp 运行环境没有安装/暴露该 Security Service，或不允许第三方 CustomApp 绑定该服务。

同日手机侧 Phone SDK 路线继续补齐系统 Companion association/observe：`com.rabi.link` 已通过系统调试命令注册到同一副 `Glasses_3268`，并补 `REQUEST_OBSERVE_COMPANION_DEVICE_PRESENCE` 后记录到 `Phone SDK Companion observing presence addressSuffix=45:55`。但完整 prerequisites 仍为 `readyForPhoneVoice=false`：`classicConnected=false`、`GlassDeviceInfo present=false`、`P2P readyForDeviceMedia=false`。这说明系统 A2DP/Companion association 不能替代 Phone SDK 私有 ClassicBT message/auth 通道；原生 ASR/TTS 仍未闭环。

随后按官方 sample 的 `RokidESecurity` / `GET_SYSTEM_INFO` 路线新增 `phone_system_info_probe`。真机日志显示 ClassicBT/P2P 两路消息请求都已发出，但 5 秒内没有 `SYSTEM_INFO_RESPONSE`，并且复查仍是 `classicConnected=false;message=false;deviceAuth=false`、`GlassDeviceInfo present=false`。这进一步说明当前缺口不是 UI 按钮或 CXRLink 会话，而是 Phone SDK 官方设备消息通道本身尚未建立。

2026-07-05 11:27 复测时已修掉 `phone.sdk` 触发 P2P/WS 组件时的 `org.slf4j.LoggerFactory` 类缺失崩溃，APK 增加 `org.slf4j:slf4j-api:1.7.36` 后，眼镜 APK 安装和 Phone SDK 前置检查不再出现 `FATAL EXCEPTION` / `NoClassDefFoundError`。最新前置检查仍是业务链路未 ready，而不是崩溃：

```text
out/rokid-native-voice/rokid-phone-voice-prereq-summary-20260705-112743.json
readyForPhoneVoice=false
companionObserved=true
btConnected=false
deviceInfoPresent=false
authReady=false
officialSystemInfoRequested=true
officialSystemInfoResponded=false
p2pConnected=false
p2pReadyForDeviceMedia=false
```

当前缺口因此进一步缩小为：系统 Companion association / observe 已存在，但 Phone SDK 私有 ClassicBT message/auth 通道、P2P 设备媒体通道和 `GlassDeviceInfo` 缓存仍没有建立。

参考链接：

- <https://developer.rokid.com/docs/5-enableVoice/rokid-vsvy-sdk-docs/RokidAiSdk/RokidAiSdk.html>
- <https://rokid.github.io/docs/6-asrandtts/asr.html>
- <https://developer.aliyun.com/article/1690327>
- <https://developer.android.com/develop/xr/jetpack-xr-sdk/asr>
- <https://developer.android.com/develop/xr/jetpack-xr-sdk/tts>
- <https://www.cnblogs.com/gccbuaa/p/19457676>
- <https://developer.volcengine.com/articles/7561249297782865947>
- <https://x-docs.rokid.com/docs/en/代码示例/35-voice-ai/02-眼镜端-TTS-与-ASR.html>

RokidAiSdk 正式路线已单独归档到：

```text
docs/rokid-ai-sdk-official-voice-plan.md
```

该路线需要开放平台 `Key` / `Secret` / `deviceTypeId` / `deviceId` / `seed`，以及 `basic/turenso/nlpconsumer/audioai` AAR 和 `workdir_asr_cn` ASR 资产。只读准备度检查：

```powershell
.\scripts\Test-RokidAiSdkReadiness.ps1
```

2026-07-05 继续复查 Sprite Enterprise 手机端 ASR/TTS 文档后，发现另一个更贴近当前工程的缺口：当前手机侧已经使用 `PSecuritySDK.getMobileEngineService().initSDK(EngineParam)`，但此前 `UserAuthInfo` 传的是空字符串。官方手机端 SDK 初始化示例把在线 ASR/TTS 授权放在 `EngineParam.userAuthInfo = UserAuthInfo(accessKey, secretKey)`。因此第 07 卡片新增了“Rokid 在线语音 AccessKey / SecretKey”和“保存语音授权”。

安全修正：实测 `phone.sdk:2.2.0-E` 会在 `initSDK` 时向 logcat 打印 `EngineParam`，其中包含 `userAuthInfo`。因此当前 APK 只保存 AK/SK 和展示配置状态，暂不自动把真实 AK/SK 注入 `EngineParam`。等找到官方无日志初始化方式、可脱敏 SDK 日志配置，或升级到可控 demo 工具链后，再打开真实注入。

边界：

- AK/SK 只保存在手机本机 SharedPreferences，不写入报告、日志、仓库或导出证据。
- 保存授权只代表本机已记录凭证，不代表已经传入 Phone SDK，也不代表原生 ASR/TTS 已闭环。
- 是否真正可用仍以 `RABI_STATUS ready/asr/tts`、`RABI_ASR:<text>` 和 `RABI_TTS_OK:<text>` 为准。
- 已把构建工具链升级到 AGP `8.4.2` / Kotlin `1.9.0` / Gradle `8.6`，并恢复打包 `phone.sdk.rfmlite`。当前 APK 内可加载 `RokidRFMLite`、`AsrManager`、`TtsManager`，但真实 AK/SK 仍因 SDK logcat 打印 `EngineParam.userAuthInfo` 暂不自动注入。

2026-07-05 新增手机侧 Rokid Phone SDK 语音引擎探针：

- `初始化手机语音`：直接初始化 `AsrEngine` / `TtsEngine`，连接官方 WebSocket endpoint。
- `手机 ASR 喂音频`：启动 `AsrEngine.startSpeech()`，并把 CXR 音频流 PCM 旁路喂给 `AsrEngine.doSpeechVoice(byte[])`。
- `手机 TTS 测试`：调用 `TtsEngine.playTts(text)`，监听 TTS 音频字节、完成和错误回调。
- `phone_*` 命令超时后会销毁 ASR/TTS engine，避免无授权时持续重连。

真机无 AK/SK 注入环境下的当前结果：

| 项目 | 证据 | 结论 |
| --- | --- | --- |
| 手机侧 ASR/TTS endpoint | `wss://api.rokid.com/ar/audio/api/ws/asr/streaming`、`wss://api.rokid.com/ar/audio/api/ws/tts` | Phone SDK 确实有在线 ASR/TTS WebSocket 引擎。 |
| 无授权连接 | `WebSocket连接失败 - Expected HTTP 101 response but was '200 OK'` | 当前空 `UserAuthInfo` 无法完成 WebSocket 握手。 |
| TTS 请求 | `Phone SDK TTS request text=... ttsConnected=false` | APK 能发起 TTS 请求，但未连接时没有音频回包。 |
| 清理 | `Phone SDK ASR/TTS probe destroyed` | 超时后已停止重连。 |

这条路线说明“不能只等眼镜端 CustomApp Glass SDK”：手机侧 SDK 可以作为 `眼镜音频流 -> 手机 Rokid ASR WebSocket -> 文本` 的候选路线，但仍需要安全注入真实授权或官方无日志初始化方式。

2026-07-05 已把官方 `RokidAiSdkDemo` 的手机侧 AudioAi service 路线接进 `com.rabi.link` 第 09 卡片：

| 项目 | 当前结果 | 证据 |
| --- | --- | --- |
| AAR/资源接入 | 已引入 `basic-1.4.3`、`turenso-1.4.3`、`nlpconsumer-1.4.3`、`audioai-1.4.3`，并打包 `workdir_asr_cn`。 | `:app:assembleDebug` 成功。 |
| APK 安装 | 已安装到 `<adb-serial>`。 | `adb install -r app-debug.apk` 成功。 |
| readiness | `assets=true;recordAudioPermission=true`。 | `rokid-native-command-filtered-20260705-083618.txt`。 |
| 初始阻塞 | 缺 `key/secret/deviceTypeId/deviceId/seed` 五段开放平台配置时不能启动。 | `missing=key,secret,deviceTypeId,deviceId,seed`。 |
| 当前硬阻塞 | 导入本地 demo 配置后，配置已完整，但测试手机是 `arm64-v8a` only；demo AAR 的语音 native 库只有 `armeabi-v7a`。 | `nativeAbi=false;requiredNativeAbi=armeabi-v7a;device32BitAbis=<none>;device64BitAbis=arm64-v8a`。 |
| 错误处理 | 未配置时点启动 ASR 不崩溃，返回 `RABI_ROKID_AI_ERROR:not_ready`。 | `rokid-native-command-filtered-20260705-083514.txt`。 |
| 配置清理 | 已新增显式 `rokid_ai_clear_config`，避免空 extra 被 Android shell 吞掉造成 1 字符脏配置。 | `Set-RokidAiSdkConfig.ps1 -Clear` 后 readiness 五项均 `<empty>`。 |

第 09 卡片的边界是：它调用 RokidAiSdk 官方 AudioAi service，用手机侧 `AudioRecord` 把麦克风 PCM 喂给 SDK，并监听 `onIntermediateSlice` / `onIntermediateEntire` 得到 ASR 文本；TTS 调 `IRokidAudioAiService.playTtsVoice(text)`。这能回答“Rokid 官方语音 SDK 能不能直接返回文本”，但在未验证音频路由前，不能自动等同于“眼镜麦克风输入”或“眼镜扬声器播报”。

新增 ADB 命令：

| 命令 | 用途 |
| --- | --- |
| `rokid_ai_probe` / `ai_probe` | 检查第 09 卡片 readiness。 |
| `rokid_ai_start` / `ai_start` | 启动 RokidAiSdk ASR service 和手机麦克风 PCM feed。 |
| `rokid_ai_stop` / `ai_stop` | 停止 RokidAiSdk service、录音线程和 socket。 |
| `rokid_ai_tts` / `ai_tts` | 调 RokidAiSdk TTS。 |
| `rokid_ai_pickup` / `rokid_ai_pickup_on` | 调 `IRokidAudioAiService.setPickUp(true)`，主动进入拾音/识别状态。 |
| `rokid_ai_pickup_off` | 调 `setPickUp(false)`，关闭拾音。 |
| `rokid_ai_clear_config` / `ai_clear_config` | 清空本机保存的五段开放平台配置。 |

写入或清空 RokidAiSdk 配置：

```powershell
.\scripts\Set-RokidAiSdkConfig.ps1 `
  -Serial <adb-serial> `
  -Key "<Rokid Key>" `
  -Secret "<Rokid Secret>" `
  -DeviceTypeId "<DeviceTypeId>" `
  -DeviceId "<DeviceId>" `
  -Seed "<Seed>"

.\scripts\Set-RokidAiSdkConfig.ps1 -Serial <adb-serial> -Clear
```

也可以从本地下载的官方 demo 源码中导入测试配置。脚本不会在 stdout 输出原值：

```powershell
.\scripts\Set-RokidAiSdkDemoConfig.ps1 -Serial <adb-serial>
```

稳定协议行：

| 协议行 | 含义 |
| --- | --- |
| `RABI_ROKID_AI_ASR_PARTIAL:<text>` | RokidAiSdk ASR 中间文本。 |
| `RABI_ROKID_AI_ASR:<text>` | RokidAiSdk ASR 最终文本，可作为消息端候选输入。 |
| `RABI_ROKID_AI_TTS_REQUEST:<text>` | 已向 RokidAiSdk 发起 TTS 请求。 |
| `RABI_ROKID_AI_ERROR:<kind>:<message>` | RokidAiSdk readiness、验证、录音、socket 或 service 错误。 |

消息端桥接已支持第 09 卡片的协议行。`Watch-RokidNativeVoiceEvents.ps1` 会把 `RABI_ROKID_AI_ASR:<text>` 归一成：

```json
{"type":"asr_text","kind":"rokid_ai_sdk","protocol":"RABI_ROKID_AI_ASR:<text>"}
```

`Start-RokidNativeVoiceWebhookBridge.ps1` 会进一步转成 RabiRoute webhook：

```json
{
  "type": "voice_transcript",
  "sourceArea": "rokid-ai-sdk-voice",
  "speakerName": "RokidAiSdk ASR",
  "text": "<text>"
}
```

已用 `adb shell log -t RabiRokidProbe 'RABI_ROKID_AI_ASR:测试AI原生语音'` 做 dry-run 验证，watcher 和 webhook bridge 均能正确输出；这只是下游消息桥验证，不代表当前真机已经跑通 RokidAiSdk ASR。

2026-07-05 继续用本地官方 demo 配置做真机验证后，推进到了新的硬阻塞：当前测试手机只支持 `arm64-v8a`，而本地 `RokidAiSdkDemo` 的语音 native 库只提供 `armeabi-v7a`，例如 `libaiverify.so`。首次强行启动时 Android 报：

```text
UnsatisfiedLinkError: dlopen failed: library "libaiverify.so" not found
```

APK 中可以看到 `lib/armeabi-v7a/libaiverify.so`，但设备：

```text
ro.product.cpu.abilist=arm64-v8a
ro.product.cpu.abilist32=<empty>
```

因此第 09 卡片 readiness 已新增 ABI 检查，当前会提前给出：

```text
nativeAbi=false;requiredNativeAbi=armeabi-v7a;device32BitAbis=<none>;device64BitAbis=arm64-v8a
```

这个结论说明：第 09 路线的 Java/AIDL 调用、assets、权限、配置和错误处理已经接好；要在当前手机上继续验证 RokidAiSdk 原生 ASR/TTS，需要 Rokid 提供含 `arm64-v8a` native 库的新版 AAR，或换一台支持 32 位 ABI 的 Android 手机。未满足 ABI 前，`rokid_ai_start` 不会再尝试启动 service，避免重复触发 native loader 异常。

新增 ABI 自检脚本：

```powershell
.\scripts\Test-RokidAiSdkAbi.ps1 -Serial <adb-serial>
```

当前输出结论：

```json
{
  "ok": false,
  "aarNativeAbis": ["armeabi-v7a"],
  "deviceAbis": ["arm64-v8a"],
  "device32BitAbis": [],
  "device64BitAbis": ["arm64-v8a"],
  "deviceCanLoadRequiredAbi": false
}
```

本地已检查 `CXRLSample.zip` / `cxrssample.zip`，没有包含 RokidAiSdk 语音 AAR；直接探测 `maven.rokid.com` 上 `com/rokid/ai/basic|audioai|turenso|nlpconsumer/maven-metadata.xml` 均为 404，因此当前本地可用的正式证据仍是随 `RokidAiSdkDemo` 分发的 `1.4.3` AAR。后续如果拿到新版 AAR，先跑 `Test-RokidAiSdkAbi.ps1`，只有 `aarNativeAbis` 和 `deviceAbis` 有交集时再做真机 `rokid_ai_start`。

2026-07-05 继续验证 Phone SDK 的设备消息前置链路后，新增了两个诊断命令：

| 命令 | 作用 | 当前真机结果 |
| --- | --- | --- |
| `phone_bt_scan` | 调用 Phone SDK `ClassicBluetoothClient.startScan()`，观察 SDK 是否能主动扫到眼镜。 | 扫到 6 个周边设备，但没有扫到已连接眼镜；`classicConnected=false;message=false;deviceAuth=false`。 |
| `phone_bt_connect` | 从 Android bonded devices 中挑选 `Glasses*` / `Rokid*`，调用 Phone SDK `connectToServer(BluetoothDevice, callback)`。 | 能找到 `Glasses_3268`，但 `connect callback success=false`；随后 `GlassDeviceInfo.present=false`。 |

这说明当前手机系统的 A2DP/蓝牙音频连接和 Rokid Phone SDK 的 ClassicBT message/auth 通道是两层东西：系统已经配对并连接眼镜，不代表 Phone SDK 能拿到 `message channel` 或 `GlassDeviceInfo.deviceId`。在 `classicConnected=false`、`message=false`、`deviceAuth=false` 时，`phone_auth_apply`、`phone_init`、`phone_tts` 和 `phone_asr_start` 都只能保持未就绪，不能标为原生 ASR/TTS 闭环。

2026-07-05 追加 Android 系统 ASR/TTS 备用探针。依据是 Android 官方“audio glasses / display glasses”文档把 `SpeechRecognizer` 和 `TextToSpeech` 作为眼镜类设备的系统语音输入/输出方式；这条路不依赖 Rokid Glass SDK，也不能证明 Rokid 原生 ASR/TTS 已 ready，只能验证当前手机系统语音服务和音频路由。

| 命令 | 作用 | 当前真机结果 |
| --- | --- | --- |
| `android_voice_probe` | 检查 `RECORD_AUDIO`、`SpeechRecognizer`、ASR service、on-device recognizer、TTS、输入/输出音频设备。 | `recordAudio=true;speechRecognizer=true;recognitionService=true;onDeviceRecognizer=false;ttsReady=true`；ASR/TTS service 均来自 `com.xiaomi.mibrain.speech`。新版 readiness 还会显示 `recordAudioAppOp`。 |
| `android_tts` | 调 Android `TextToSpeech.speak(text)` 并等 `onDone`。 | 成功：`Android system TTS speak requested result=0`，随后 `Android system TTS onDone`。现场是否从眼镜播出仍需听感确认；`AudioManager` 输出设备未列出 `BLUETOOTH_A2DP` 或 `Glasses_3268`。 |
| `android_asr_start` / `android_asr_stop` | 调 Android `SpeechRecognizer.startListening()` / stop。 | 给 `com.xiaomi.mibrain.speech` 补 `RECORD_AUDIO` 后可进入 `readyForSpeech` 并收到音频 buffer；无人声时会 `ERROR_NO_MATCH`，短句可能 `ERROR_NETWORK_TIMEOUT`。 |
| `android_asr_tts_loop` / `android_loopback` | 先启动 Android 系统 ASR，再用 Android 系统 TTS 播一句测试文本，让手机麦克风/系统 ASR 回收文本。 | 已成功：`Android system TTS onDone text=Rabi 原生 TTS 测试` 后收到 `Android system ASR final=ROBBY原声TTS测试`。这是系统层回环，不是眼镜原生 ASR/TTS，也不能证明眼镜麦克风。 |

因此，“想语音说”目前可以分成三层判断：系统 TTS 已经能由 APK 调起并收到完成回调；Android 系统 ASR 在补齐小米系统语音服务麦克风权限后可以返回文本；但当前音频设备列表没有证明眼镜麦克风/扬声器作为系统蓝牙音频设备暴露给 APK。这条路适合保留为备用/对照探针，不应替代 Rokid 原生 ASR/TTS 验收。

为了让后续消息端不用解析中文日志，第 08 卡片现在会额外输出稳定协议行：

| 协议行 | 含义 | 示例 |
| --- | --- | --- |
| `RABI_ANDROID_ASR:<text>` | Android 系统 ASR final 文本，可作为系统层 `voice_transcript` 候选输入。 | `RABI_ANDROID_ASR:ROBBY原声TTS测试` |
| `RABI_ANDROID_TTS_OK:<text>` | Android 系统 TTS 已收到 `onDone`，表示系统 TTS 合成/播放请求完成。 | `RABI_ANDROID_TTS_OK:Rabi 原生 TTS 测试` |

`scripts/Test-RokidNativeVoiceRealDevice.ps1` 的 JSON summary 也会写出结构化结果：

```json
{
  "results": {
    "androidSystemAsrFinalText": "ROBBY原声TTS测试",
    "androidSystemTtsDoneText": "Rabi 原生 TTS 测试",
    "androidSystemAsrProtocolSeen": true,
    "androidSystemTtsProtocolSeen": true
  }
}
```

当前真机上让系统 ASR 从 `ERROR_INSUFFICIENT_PERMISSIONS` 进入可采音状态，需要临时确保系统语音服务也有麦克风权限：

```powershell
$adb = ".\out\tools\android-sdk\platform-tools\adb.exe"
& $adb -s <adb-serial> shell pm grant com.xiaomi.mibrain.speech android.permission.RECORD_AUDIO
& $adb -s <adb-serial> shell appops set com.xiaomi.mibrain.speech RECORD_AUDIO allow
```

复测命令：

```powershell
.\scripts\Test-RokidNativeVoiceRealDevice.ps1 `
  -Serial <adb-serial> `
  -Commands android_asr_tts_loop,android_asr_stop `
  -TtsText "Rabi 原生 TTS 测试" `
  -AsrListenSeconds 14 `
  -NoForceStop
```

也可以用本机脚本写入授权，脚本通过 base64 extras 传给手机 APK，stdout 不输出密钥：

```powershell
.\scripts\Set-RokidNativeVoiceAuth.ps1 `
  -Serial <adb-serial> `
  -AccessKey "<Rokid AccessKey>" `
  -SecretKey "<Rokid SecretKey>"
```

注意：脚本参数可能留在本机 shell 历史里。正式使用时不要把真实 AK/SK 写入文档、报告、截图或提交记录。

清空本机保存的在线语音授权：

```powershell
.\scripts\Set-RokidNativeVoiceAuth.ps1 -Serial <adb-serial> -Clear
```

## 状态分层

第 07 卡片把能力分成三层，不再把 CustomApp 会话等同于 ASR/TTS 可用。`Ping 眼镜` 只证明手机和眼镜 APK 的消息通路可达；`查询原生状态` 会读取 `RABI_STATUS` 并解析 `ready/asr/tts/message/serverPackage/serviceConnected`。只有 `asr=true` 才显示远程 ASR 按钮，只有 `tts=true` 才显示 TTS 按钮，只有二者同时可用才显示 ASR 回声测试。

| 状态 | 含义 | 证明 |
| --- | --- | --- |
| `installed` | 眼镜端 APK 已安装 | `onQueryAppResult installed=true` 或 `onInstallAppResult=true` |
| `started` | 眼镜端 APK 已启动 | `onOpenAppResult=true` 或 `onGlassAppResume=true` |
| `message` | 手机和眼镜 APK 消息已打通 | 收到 `RABI_PONG:`、ASR 文本、TTS ack 或错误回传 |
| `native status` | 眼镜 APK 内 Glass SDK 服务状态 | 收到并解析 `RABI_STATUS:ready=<bool>;asr=<bool>;tts=<bool>;...` |

按钮显示规则：

| 按钮 | 显示条件 |
| --- | --- |
| 查询安装 / 安装眼镜 APK | CustomApp 会话 ready |
| 启动眼镜 APK | CustomApp 会话 ready 且已安装但未启动 |
| Ping 眼镜 / 查询原生状态 | 眼镜 APK 已启动 |
| 远程开始 ASR / 远程停止 ASR | `RABI_STATUS` 里 `ready=true;asr=true` |
| 发送 TTS 测试 | `RABI_STATUS` 里 `ready=true;tts=true` |
| ASR 回声测试 | `RABI_STATUS` 里 `ready=true;asr=true;tts=true` |
| 保存语音授权 | 第 07 卡片可见时始终显示；用于补齐 Phone SDK `UserAuthInfo` |

## 消息协议

手机发给眼镜：

| 命令 | 方向 | 用途 |
| --- | --- | --- |
| `RABI_PING` | 手机 -> 眼镜 | 验证眼镜 APK 消息监听可达 |
| `RABI_STATUS` | 手机 -> 眼镜 | 查询眼镜测试 APK 内 Glass SDK / ASR / TTS / MessageService 可用性 |
| `RABI_ASR_START` | 手机 -> 眼镜 | 请求眼镜端调用 Glass SDK ASR |
| `RABI_ASR_STOP` | 手机 -> 眼镜 | 请求眼镜端停止 ASR |
| `RABI_TTS:<text>` | 手机 -> 眼镜 | 请求眼镜端 TTS 播报文本 |

眼镜回手机：

| 消息 | 方向 | 含义 |
| --- | --- | --- |
| `RABI_PONG:<timestamp>` | 眼镜 -> 手机 | Ping 成功 |
| `RABI_STATUS:ready=<bool>;asr=<bool>;tts=<bool>;message=<bool>;serverPackage=<bool>;bindRequested=<bool>;serviceConnected=<bool>;registerRequested=<bool>;clientReady=<bool>;recordAudioGranted=<bool>;btConnectGranted=<bool>;event=<state>;error=<reason>` | 眼镜 -> 手机 | 眼镜测试 APK 内 Glass SDK、语音/消息服务、服务包可见性、绑定状态和权限诊断 |
| `RABI_ASR_START_OK:started` | 眼镜 -> 手机 | `startSpeech()` 已调用成功 |
| `RABI_ASR_START_ERR:<reason>` | 眼镜 -> 手机 | ASR 启动失败，例如权限、SDK 或服务不可用 |
| `RABI_ASR_STOP_OK:stopped` | 眼镜 -> 手机 | `stopSpeech()` 已调用成功 |
| `RABI_ASR_STOP_ERR:<reason>` | 眼镜 -> 手机 | ASR 停止失败 |
| `RABI_ASR:<text>` | 眼镜 -> 手机 | ASR 完整识别文本 |
| `RABI_ASR_ERR:<reason>` | 眼镜 -> 手机 | ASR runtime 错误，例如 `onError(code)` |
| `RABI_TTS_OK:<text>` | 眼镜 -> 手机 | TTS 调用无异常 |
| `RABI_TTS_ERR:<reason>` | 眼镜 -> 手机 | TTS 服务不可用或调用异常 |

注意：`RABI_TTS_OK` 目前只表示 `doSpeechTts(text)` 调用无异常，不等同于播报完成事件。当前 SDK 样例里还没有接到独立的 TTS completion callback。

## ADB 自测

无眼镜环境可以用注入方式验证手机端状态机、日志和错误展示：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Test-RokidNativeVoiceBridge.ps1 -Serial <adb-serial> -Install
```

可选参数：

| 参数 | 用途 |
| --- | --- |
| `-Build` | 先执行 `assembleDebug` |
| `-Install` | 安装 `app-debug.apk` 到手机 |
| `-Serial <adb-serial>` | 指定设备 |
| `-AdbPath <path>` | 指定 adb |
| `-SkipFailureCases` | 只跑成功路径注入 |
| `-SkipTimeoutCase` | 跳过回包超时路径注入 |
| `-OutputDir <path>` | 指定日志输出目录 |

脚本输出：

- `out/rokid-native-voice/rokid-native-voice-summary-*.json`
- `out/rokid-native-voice/rokid-native-voice-filtered-*.txt`
- `out/rokid-native-voice/rokid-native-voice-raw-*.txt`

自测只能证明手机端协议解析、UI 状态和日志记录正常，不能证明眼镜端 Glass SDK ASR/TTS 真正可用。

自测默认还会注入一次 `native_voice_mode=timeout`。它不会给眼镜发命令，只用于验证手机端 pending/timeout 状态机：如果 7 秒内没有收到对应回包，页面应写入 `眼镜原生语音回包超时`，并把第 07 卡片记为 `failed`。

状态门控可以用 `native_voice_mode=status` 注入 `RABI_STATUS` 的 payload 自测。这个入口只验证页面解析和按钮显示规则，不代表真实眼镜服务可用；带分号的状态文本建议通过 `native_voice_text_b64` 传入，避免 Android shell 截断。

## 真机无注入检查

真实眼镜验证使用独立脚本，不注入任何 `native_voice_mode` 回包，只通过 `native_voice_command` 发送真实命令，然后从 logcat 收集手机和眼镜 SDK 的真实回包。

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Install-RokidGlassAsrWithRetry.ps1 -Serial <adb-serial> -MaxAttempts 4
.\scripts\Test-RokidNativeVoiceRealDevice.ps1 -Serial <adb-serial> -Commands ping,tts,asr_start,asr_stop
```

默认命令顺序：

| 命令 | 行为 |
| --- | --- |
| `ping` | 发送 `RABI_PING`，等待真实 `RABI_PONG:` |
| `tts` | 发送 `RABI_TTS:<文本>`，等待真实 `RABI_TTS_OK:` 或错误 |
| `asr_start` | 发送 `RABI_ASR_START`，脚本等待一段时间；此时需要对眼镜说话 |
| `asr_stop` | 发送 `RABI_ASR_STOP`，等待真实 stop ack |
| `phone_device_handshake` | 通过 Phone SDK `requestAudioStream(tag)` 触发设备服务握手，回调后自动 `stopAudioStream(tag)`；5 秒无回调会记录 timeout，用于判断 Phone SDK 自己的设备消息通道是否可用 |
| `phone_device_info` | 检查 Phone SDK 是否已经缓存 `GlassDeviceInfo`；只输出字段存在性和长度 |
| `phone_auth_probe` | 检查手机侧在线语音授权 readiness，只输出 header 是否存在和长度 |
| `phone_auth_apply` | 在已配置 AK/SK 且 Phone SDK 已拿到 `GlassDeviceInfo` 时，安全生成 app token 并写入语音 header |
| `phone_init` | 初始化手机侧 Rokid ASR/TTS WebSocket engine |
| `phone_tts` | readiness 通过后调用手机侧 `TtsEngine.playTts(text)`；未通过时直接记录 not ready |
| `phone_asr_start` | 启动手机侧 `AsrEngine.startSpeech()`，并把 CXR PCM 旁路喂入 |
| `phone_asr_stop` | 停止手机侧 ASR 喂音频 |

可选参数：

| 参数 | 用途 |
| --- | --- |
| `-Build` | 先执行 `assembleDebug` |
| `-Install` | 安装 `app-debug.apk` 到手机 |
| `-TtsText <text>` | 指定眼镜要播报的文本 |
| `-AsrListenSeconds <seconds>` | `asr_start` 或 `echo_start` 后等待用户说话的秒数 |
| `-AllowNoAsrText` | 只验证 ASR 启动/停止，不把“没有 ASR 文本”视为失败 |
| `-KeepLogcat` | 不清空已有 logcat |
| `-NoForceStop` | 不强停手机 APK，保留当前页面状态 |
| `-OutputDir <path>` | 指定日志输出目录 |

脚本输出：

- `out/rokid-native-voice/rokid-native-voice-real-summary-*.json`
- `out/rokid-native-voice/rokid-native-voice-real-filtered-*.txt`
- `out/rokid-native-voice/rokid-native-voice-real-raw-*.txt`

`passed=true` 的默认含义更严格：如果包含 `asr_start`，必须收到非空 `RABI_ASR:<text>` 或手机日志里的 `收到眼镜端原生 ASR 文本`；只收到 `RABI_ASR_START_OK:started` 只能证明 ASR 服务被调用，不能证明已经拿到用户说了什么。

## 外部命令入口

除了页面按钮，外部脚本也可以通过 Activity intent 驱动手机端原生语音桥。这个入口用于后续把 `com.rabi.link` 接成外部可调用的手机侧桥。

状态边界：下面的消息端桥接章节是“拿到真实 `asr_text` / `tts_ack` 之后”的下游设计，不代表 Rokid 原生 ASR/TTS 当前已经可用。当前可用事实仍以 `Assert-RokidNativeVoiceCompletion.ps1` 和 `docs/rokid-ai-sdk-official-voice-plan.md` 为准。

推荐先用单命令脚本封装 ADB 调用：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Send-RokidNativeVoiceCommand.ps1 -Serial <adb-serial> -Command tts -Text "这是一条外部命令 TTS" -WaitSeconds 3
```

脚本输出 JSON：

| 字段 | 含义 |
| --- | --- |
| `ok` | 手机端 Activity 接受命令、已尝试发送给 Phone SDK，且没有手机侧崩溃或错误 |
| `acknowledged` | logcat 中看到了眼镜侧真实回包，例如 `RABI_PONG:` / `RABI_TTS_OK:` / `RABI_ASR:<text>` |
| `status` | `requested` 表示只证明手机侧已发出；`acknowledged` 表示看到眼镜回包；`failed` 表示手机侧命令失败或出现错误 |
| `checks.responseSeen` | 是否看到任意真实眼镜回包 |
| `filteredLog` / `rawLog` | 本次命令的证据日志路径 |

支持的 `-Command`：

| 命令 | 用途 |
| --- | --- |
| `ping` | 验证眼镜 APK 消息监听是否可达 |
| `status` | 查询眼镜测试 APK 内 Glass SDK / ASR / TTS / MessageService 可用性 |
| `tts` | 让眼镜播报 `-Text` |
| `asr_start` / `start_asr` | 开始眼镜端原生 ASR |
| `asr_stop` / `stop_asr` | 停止眼镜端原生 ASR |
| `echo_start` / `start_echo` | 启动 ASR->TTS 回声闭环 |

这个脚本是消息端集成入口，不做注入、不伪造回包；它的 `ok=true` 不是 ASR/TTS 已完成，只表示手机侧桥已经把命令送出。是否真的听到用户说话或完成播报，要看 `acknowledged`、`checks.responseSeen` 和证据日志。

入站事件用独立监听脚本输出 JSONL：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Watch-RokidNativeVoiceEvents.ps1 -Serial <adb-serial> -Dedupe
```

监听脚本会解析手机 logcat 里的 `RABI_*` 协议和手机侧明确日志，输出形如：

```json
{"type":"asr_text","text":"用户说的话","command":"","kind":"","channel":"P2P","clientId":"GlassSample","protocol":"RABI_ASR:用户说的话","observedAt":"2026-07-05 03:24:59 +08:00"}
```

Android 系统语音备用路线也会被归一成同一个事件形状，但 `kind` 会标成 `android_system`，避免和 Rokid 原生能力混淆：

```json
{"type":"asr_text","text":"ROBBY原声TTS测试","command":"","kind":"android_system","channel":"","clientId":"","protocol":"RABI_ANDROID_ASR:ROBBY原声TTS测试","observedAt":"2026-07-05 07:57:01 +08:00"}
```

事件类型：

| `type` | 含义 |
| --- | --- |
| `asr_text` | ASR 返回文本；`kind=android_system` 时表示 Android 系统 ASR 备用路线 |
| `tts_ack` | TTS 调用成功回包；`kind=android_system` 时表示 Android 系统 TTS 收到 `onDone` |
| `command_ack` | `ping` / `asr_start` / `asr_stop` 等命令回包 |
| `native_voice_error` | ASR/TTS/命令错误 |
| `native_voice_timeout` | 手机侧等待回包超时 |

常用参数：

| 参数 | 用途 |
| --- | --- |
| `-Dump` | 只解析当前 logcat 后退出，适合测试和采集证据 |
| `-ClearBeforeWatch` | 启动监听前清空 logcat |
| `-Dedupe` | 去重重复的 D/I 日志 |
| `-IncludeRaw` | JSON 里包含原始 logcat 行 |
| `-OutputFile <path>` | 同时把 JSONL 写入文件 |

最小消息端闭环可以分成两个进程：

1. 长驻监听：

```powershell
.\scripts\Watch-RokidNativeVoiceEvents.ps1 -Serial <adb-serial> -ClearBeforeWatch -Dedupe
```

2. 外部命令：

```powershell
.\scripts\Send-RokidNativeVoiceCommand.ps1 -Serial <adb-serial> -Command asr_start -WaitSeconds 1
.\scripts\Send-RokidNativeVoiceCommand.ps1 -Serial <adb-serial> -Command tts -Text "收到你的消息" -WaitSeconds 1
```

监听进程收到 `asr_text` 后，上层消息端可以把 `text` 当成用户输入；需要播报时，再调用 `Send-RokidNativeVoiceCommand.ps1 -Command tts -Text <reply>` 或在备用路线下调用 `-Command android_tts -Text <reply>`。Rokid 原生路线仍然依赖眼镜端 APK 和 Rokid SDK 的真实回包；Android 系统路线只证明手机系统 ASR/TTS 可用，不证明眼镜麦克风或眼镜扬声器已被选中。

## 接入 RabiRoute Webhook

状态：桥接脚本可用；Rokid 原生 ASR 文本仍待闭环。当前可直接转发的稳定输入是 Android 系统 ASR 的 `RABI_ANDROID_ASR:<text>`，它会以 `type=asr_text`、`kind=android_system` 进入同一条 webhook 路线。CustomApp / Glass SDK 路线仍需等真实 `RABI_ASR:<text>`。

RabiRoute 已有通用 Webhook / FenneNote 风格的消息端，所以当前不需要先改核心 adapter。可以先用本地桥脚本把 ASR 文本转成 `voice_transcript` payload：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Start-RokidNativeVoiceWebhookBridge.ps1 `
  -Serial <adb-serial> `
  -WebhookUrl http://127.0.0.1:8791/webhook `
  -ClearBeforeWatch `
  -Dedupe
```

桥脚本的输入来自 `Watch-RokidNativeVoiceEvents.ps1`，默认只转发 `asr_text`。输出到 RabiRoute 的 payload：

```json
{
  "type": "voice_transcript",
  "source": "rokid-native-voice",
  "sourceDeviceName": "Rokid Glass",
  "sourceArea": "rokid-glass",
  "sessionId": "rokid-native-20260705-032929",
  "messageId": "rokid-native-20260705032930296",
  "time": 1783193370,
  "text": "用户说的话",
  "speakerKind": "user",
  "speakerName": "Rokid 原生 ASR"
}
```

如果输入来自 Android 系统语音，桥脚本会把 `sourceArea` 改为 `android-system-voice`，把 `speakerName` 改为 `Android 系统 ASR`。这只是来源标注变化，payload 仍然是 RabiRoute 可接收的 `voice_transcript`。

测试 payload 生成但不发送：

```powershell
.\scripts\Start-RokidNativeVoiceWebhookBridge.ps1 -Serial <adb-serial> -Dump -Dedupe -DryRun -MaxEvents 1
```

消息端闭环建议先按这个顺序跑：

1. 启动 RabiRoute，启用 `webhook` 或 `fennenote` 类消息端。
2. 打开手机 APK，完成 Android 权限；如果测试 Rokid 原生路线，再完成 Rokid 授权、CustomApp 会话、眼镜 APK 安装/启动。
3. Android 系统备用路线用 `Send-RokidNativeVoiceCommand.ps1 -Command android_asr_start` 或页面上的系统 ASR 按钮；Rokid 原生路线用 `Send-RokidNativeVoiceCommand.ps1 -Command ping` 确认 `acknowledged=true` 或监听端收到 `command_ack`。
4. 启动 `Start-RokidNativeVoiceWebhookBridge.ps1` 长驻监听。
5. 用 `Send-RokidNativeVoiceCommand.ps1 -Command asr_start` 开始 Rokid 原生 ASR，或继续使用 Android 系统 ASR。
6. 用户说话，桥脚本收到 `asr_text` 后 POST 给 RabiRoute。
7. Agent / RabiRoute 需要播报时，Rokid 原生路线调用 `Send-RokidNativeVoiceCommand.ps1 -Command tts -Text <reply>`；Android 系统备用路线调用 `-Command android_tts -Text <reply>`。

边界：这个桥只把“已拿到的 ASR 文本”接成 RabiRoute 输入端；它不会自动把任意 Agent 回复播报出去。TTS 仍作为显式外发动作保留，方便后续接 RabiRoute 的 draft / approval / audit 安全门。来源必须看 `kind` / `sourceArea`：`android_system` 是手机系统备用路线，不是 Rokid 原生能力验收。

## 接入 RabiRoute TTS 输出

状态：待原生 TTS ack 闭环后启用。当前 CustomApp 路线还没有真实 `RABI_TTS_OK`，所以本节不能作为已完成播放能力验收。

RabiRoute 的 `voice_chat` pipeline 会把播放请求转发到 FenneNote 风格的 playback endpoint。Rokid 原生 TTS 可以用本地播放端兼容这个接口：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Start-RokidNativeTtsPlaybackServer.ps1 -Serial <adb-serial> -Port 8794
```

播放端默认接受这些路径：

| 路径 | 用途 |
| --- | --- |
| `/api/fennenote/playback` | 兼容 RabiRoute / FenneNote playback |
| `/api/playback/request` | 兼容 RabiRoute manager 旧播放请求路径 |
| `/api/rokid/tts` | Rokid 专用 TTS 测试入口 |

它会从请求 JSON 里按顺序读取 `ttsText`、`text`、`message`、`content`、`visibleText`，也兼容 `payload.text` / `payload.ttsText`。读取到文本后调用：

```powershell
.\scripts\Send-RokidNativeVoiceCommand.ps1 -Command tts -Text <speech>
```

如果要把同一个 playback server 切到 RokidAiSdk TTS 路线：

```powershell
.\scripts\Start-RokidNativeTtsPlaybackServer.ps1 -Port 8794 -TtsCommand rokid_ai_tts
```

或一键启动桥栈时指定：

```powershell
.\scripts\Start-RokidNativeVoiceStack.ps1 -Serial <adb-serial> -TtsCommand rokid_ai_tts
```

`-TtsCommand android_tts` 也可用于 Android 系统 TTS 备用路线。当前默认仍是 `tts`，即眼镜 CustomApp / Glass SDK TTS 路线。

自测播放端但不发给手机：

```powershell
.\scripts\Start-RokidNativeTtsPlaybackServer.ps1 -Port 8794 -DryRun -Once
```

另开一个 PowerShell：

```powershell
Invoke-WebRequest `
  -Uri http://127.0.0.1:8794/api/fennenote/playback `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body '{"text":"Rokid 原生 TTS 播放端自测","play":true}'
```

接 RabiRoute 时，把 FenneNote playback URL 指向这个服务即可：

```powershell
$env:FENNOTE_PLAYBACK_URL = "http://127.0.0.1:8794/api/fennenote/playback"
```

示例 route 配置：

```text
<repo>\examples\data\route\rokid-native-voice\adapterConfig.json
```

它采用：

| 字段 | 值 |
| --- | --- |
| `messageAdapters` | `["webhook"]` |
| `pipeline.inputAdapter` | `webhook` |
| `pipeline.outputAdapter` | `fennenote` |
| `pipeline.outputPipeline` | `rokid-native-tts` |
| `pipeline.ttsProvider` | `rokid-native` |
| `pipeline.ttsWorkerUrl` | `http://127.0.0.1:8794/api/fennenote/playback` |

注意：当前 RabiRoute outbox 的 FenneNote playback 实际转发目标读取 `FENNOTE_PLAYBACK_URL` / manager 配置；`ttsWorkerUrl` 主要用于注入给 Agent 和文档化目标。因此真实运行时仍建议设置：

```powershell
$env:FENNOTE_PLAYBACK_URL = "http://127.0.0.1:8794/api/fennenote/playback"
```

当前播放端返回：

| 字段 | 含义 |
| --- | --- |
| `ok` | 手机侧 TTS 命令已接受或 dry-run 成功 |
| `status=requested` | 已发给 Phone SDK，但未确认眼镜播报完成 |
| `status=acknowledged` | 看到了眼镜 `RABI_TTS_OK:` 回包 |
| `commandResult` | `Send-RokidNativeVoiceCommand.ps1` 的原始证据 |

边界：这个服务不合成音频，也不替代 OumuQ；它只是把已经生成好的朗读文本交给 Rokid 眼镜原生 TTS。没有真实 `RABI_TTS_OK:` 和实际听到播报前，仍只能证明手机侧命令已发出。

## 推荐启动顺序

### 方式 0：一条命令跑 trial

先只验证编排、readiness、证据包和完成判定，不跑真机命令：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Run-RokidNativeVoiceTrial.ps1 -Serial <adb-serial> -SkipRealDevice
```

真机试跑时去掉 `-SkipRealDevice`：

```powershell
.\scripts\Run-RokidNativeVoiceTrial.ps1 `
  -Serial <adb-serial> `
  -Commands ping,tts,asr_start,asr_stop `
  -TtsText "Rabi 原生 TTS 真机测试"
```

这个脚本会依次执行：

1. 启动本地 ASR/TTS 桥栈。
2. 跑 readiness 前置检查。
3. 跑真机无注入命令测试，除非指定 `-SkipRealDevice`。
4. 再跑一次 readiness。
5. 采集 evidence 包。
6. 跑 `Assert-RokidNativeVoiceCompletion.ps1` 完成判定。
7. 默认停止本地桥栈；如果要保留后台桥，加 `-KeepStackRunning`。

输出目录：

```text
out/rokid-native-voice/trial-*/rokid-native-trial-summary.json
out/rokid-native-voice/trial-*/evidence/rokid-native-evidence-index.json
out/rokid-native-voice/trial-*/evidence/rokid-native-completion-verdict.json
```

### 方式 A：一键启动本地桥栈

只启动本地桥，不启动 RabiRoute manager：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Start-RokidNativeVoiceStack.ps1 `
  -Serial <adb-serial> `
  -WebhookUrl http://127.0.0.1:8791/webhook `
  -TtsPort 8794
```

启动脚本会后台启动：

| 进程 | 脚本 | 作用 |
| --- | --- | --- |
| `rokid-native-tts-playback` | `Start-RokidNativeTtsPlaybackServer.ps1` | 接 RabiRoute playback 请求，转成眼镜 TTS 命令 |
| `rokid-native-asr-webhook` | `Start-RokidNativeVoiceWebhookBridge.ps1` | 监听 ASR JSONL 事件，POST 到 RabiRoute webhook |

manifest 和日志写到：

```text
apps/rabilink-android/out/rokid-native-voice/rokid-stack-*/rokid-native-voice-stack.json
apps/rabilink-android/out/rokid-native-voice/rokid-stack-*/*.log
```

停止最近一次启动的本地桥栈：

```powershell
.\scripts\Stop-RokidNativeVoiceStack.ps1
```

或按 manifest 精确停止：

```powershell
.\scripts\Stop-RokidNativeVoiceStack.ps1 -ManifestPath .\out\rokid-native-voice\rokid-stack-YYYYMMDD-HHMMSS\rokid-native-voice-stack.json
```

### 方式 B：手动分开启动

1. 启动 Rokid TTS playback server：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Start-RokidNativeTtsPlaybackServer.ps1 -Serial <adb-serial> -Port 8794
```

2. 启动 RabiRoute，使用 `rokid-native-voice` 这类 route 配置，并让 playback 指向 Rokid 服务：

```powershell
cd <repo>
$env:FENNOTE_PLAYBACK_URL = "http://127.0.0.1:8794/api/fennenote/playback"
npm run start:manager
```

3. 启动 ASR webhook bridge：

```powershell
cd <repo>\apps\rabilink-android
.\scripts\Start-RokidNativeVoiceWebhookBridge.ps1 `
  -Serial <adb-serial> `
  -WebhookUrl http://127.0.0.1:8791/webhook `
  -ClearBeforeWatch `
  -Dedupe
```

4. 在手机 APK 内完成 Rokid 授权、CustomApp 会话、安装/启动眼镜端 APK。

5. 跑 readiness 检查，先确认前置状态和最近回包：

```powershell
.\scripts\Test-RokidNativeVoiceReadiness.ps1 -Serial <adb-serial>
```

输出里的关键字段：

| 字段 | 含义 |
| --- | --- |
| `DeviceListed` | ADB 能看到手机 |
| `PhoneApkInstalled` | `com.rabi.link` 已安装 |
| `RokidAiAppInstalled` | Rokid AI App 已安装 |
| `BridgeProcessesRunning` | 本地 ASR webhook bridge 和 TTS playback server 都在运行 |
| `RealPongSeen` | 最近日志里看到真实 `RABI_PONG` 或 ping ack |
| `RealAsrTextSeen` | 最近日志里看到真实 `RABI_ASR:<text>` |
| `RealTtsAckSeen` | 最近日志里看到真实 `RABI_TTS_OK:<text>` |
| `NoFatalException` | 最近日志无 `FATAL EXCEPTION` |

脚本会写出完整 summary：

```text
out/rokid-native-voice/rokid-native-readiness-summary-*.json
out/rokid-native-voice/rokid-native-readiness-log-*.txt
```

6. 真机验收：

```powershell
.\scripts\Test-RokidNativeVoiceRealDevice.ps1 -Serial <adb-serial> -Commands ping,tts,asr_start,asr_stop
```

7. 采集本轮证据包：

```powershell
.\scripts\Collect-RokidNativeVoiceEvidence.ps1 -RecentFileCount 5
```

证据包会复制最近的 readiness、自测、真机测试、单命令测试、stack manifest 和关联 filtered log，并生成索引：

```text
out/rokid-native-voice/evidence-*/rokid-native-evidence-index.json
```

如果需要把 APK 一并放进证据包：

```powershell
.\scripts\Collect-RokidNativeVoiceEvidence.ps1 -RecentFileCount 5 -IncludeApkInfo
```

证据包里 `completionEvidenceStillRequired` 会保留最终验收仍需的硬证据。没有同一路线的真实回包时，只能说明桥接层准备好了，不能说明原生 ASR/TTS 真机闭环已完成：Glass SDK 路线需要 `RABI_ASR:<text>` + `RABI_TTS_OK:<text>`；RokidAiSdk 路线需要 `RABI_ROKID_AI_ASR:<text>` + `RABI_ROKID_AI_TTS_REQUEST:<text>`。

8. 跑完成判定门：

```powershell
.\scripts\Assert-RokidNativeVoiceCompletion.ps1
```

这个脚本默认读取最新 evidence index，只采信真机无注入证据、单命令真机证据和 readiness 里的真实 `RABI_*` 回包，不采信注入自测。它需要同时满足：

| 要求 | 证据 |
| --- | --- |
| 真机无注入测试已跑 | `Test-RokidNativeVoiceRealDevice.ps1` 生成 summary |
| 手机到眼镜消息可达 | 真实 `RABI_PONG` 或 ping ack |
| 原生 ASR 能启动 | 真实 `RABI_ASR_START_OK` 或 asr_start ack |
| 原生 ASR 返回文本 | 真实 `RABI_ASR:<非空文本>` |
| 原生 TTS 被眼镜接受 | 真实 `RABI_TTS_OK:<文本>` |
| 实际听到播报 | 人工确认后加 `-ConfirmHeardTts` |
| 无崩溃 | readiness 或真机 summary 里的 `noFatalException=true` |

如果已经实际听到眼镜播报，再运行：

```powershell
.\scripts\Assert-RokidNativeVoiceCompletion.ps1 -ConfirmHeardTts
```

只有这个脚本 `Passed=True` 时，才可以把“原生 ASR/TTS 真机闭环”标为完成。

这套顺序对应的消息链路是：

```text
Rokid Glass ASR
  -> 手机 APK / RABI_ASR
  -> Watch-RokidNativeVoiceEvents.ps1
  -> Start-RokidNativeVoiceWebhookBridge.ps1
  -> RabiRoute webhook voice_transcript
  -> Agent
  -> RabiRoute /api/agent/replies
  -> FENNOTE_PLAYBACK_URL
  -> Start-RokidNativeTtsPlaybackServer.ps1
  -> Send-RokidNativeVoiceCommand.ps1
  -> 手机 APK / RABI_TTS
  -> Rokid Glass TTS
```

底层 intent 形式如下：

```powershell
adb shell am start -n com.rabi.link/.modules.rokid.RokidProbeActivity `
  --es native_voice_command tts `
  --es native_voice_text "这是一条外部命令 TTS"
```

支持的 `native_voice_command`：

| 命令 | 用途 |
| --- | --- |
| `ping` | 发送 `RABI_PING` |
| `status` | 发送 `RABI_STATUS`，查询眼镜端测试 APK 的 Glass SDK ready/ASR/TTS/消息服务状态 |
| `diag` / `native_diag` / `glass_diag` | 发送 `RABI_DIAG`，新版眼镜 APK 会返回增强版 `RABI_STATUS`，包含可见 Rokid 包、候选 Security Service 包、设备信息、眼镜端 ABI 和 native library 路径 |
| `asr_start` / `start_asr` | 发送 `RABI_ASR_START` |
| `asr_stop` / `stop_asr` | 发送 `RABI_ASR_STOP` |
| `tts` | 发送 `RABI_TTS:<native_voice_text>` |
| `echo_start` / `start_echo` | 启动 ASR 回声测试 |
| `offline_cmd_arm` / `offline_arm` / `arm_offline_cmd` | 发送 `RABI_OFFLINE_CMD_ARM`，尝试在眼镜端注册离线固定词条；当前真机返回 `glass_sdk_not_ready`。 |
| `offline_cmd_clear` / `offline_clear` / `clear_offline_cmd` | 发送 `RABI_OFFLINE_CMD_CLEAR`，尝试清除眼镜端离线固定词条；同样依赖 Glass SDK ready。 |
| `glass_android_voice_probe` / `glass_android_voice` / `glass_system_voice` | 发送 `RABI_GLASS_ANDROID_VOICE_PROBE`，在眼镜测试 APK 内检查 Android 系统 `SpeechRecognizer` / `TextToSpeech`。当前真机为 `speechRecognizer=false;ttsReady=false`。 |
| `glass_android_asr_start` / `start_glass_android_asr` / `glass_system_asr_start` | 发送 `RABI_GLASS_ANDROID_ASR_START`，尝试在眼镜端启动 Android 系统 ASR；当前返回 `asr:speech_recognizer_unavailable`。 |
| `glass_android_asr_stop` / `stop_glass_android_asr` / `glass_system_asr_stop` | 发送 `RABI_GLASS_ANDROID_ASR_STOP`，停止眼镜端 Android 系统 ASR。 |
| `glass_android_tts` / `glass_system_tts` | 发送 `RABI_GLASS_ANDROID_TTS:<text>`，尝试在眼镜端调用 Android 系统 TTS；当前返回 `tts:tts_not_ready`。 |
| `glass_rokid_ai_probe` / `glass_ai_probe` / `glass_rokid_ai_status` | 发送 `RABI_GLASS_ROKID_AI_PROBE`，检查眼镜端 RokidAiSdk AAR、ASR assets、32 位 ABI、录音权限和凭证 readiness。 |
| `glass_rokid_ai_start` / `start_glass_rokid_ai` / `glass_ai_start` | 发送 `RABI_GLASS_ROKID_AI_START`，尝试在眼镜端启动官方 RokidAiSdk；当前无凭证时返回 `not_ready`。 |
| `glass_rokid_ai_stop` / `stop_glass_rokid_ai` / `glass_ai_stop` | 发送 `RABI_GLASS_ROKID_AI_STOP`，停止眼镜端 RokidAiSdk 服务并释放录音线程。 |
| `glass_rokid_ai_tts` / `glass_ai_tts` | 发送 `RABI_GLASS_ROKID_AI_TTS:<text>`，服务连接后调用官方 TTS。 |
| `phone_device_handshake` / `phone_audio_handshake` / `probe_phone_device_handshake` | 通过 Phone SDK 设备服务请求一次 audio stream 握手，回调后自动停止；5 秒无回调会记录 timeout，用于诊断 Phone SDK 设备消息通道 |
| `phone_device_info` / `phone_glass_device` / `probe_phone_device_info` | 检查 Phone SDK 是否已经缓存 `GlassDeviceInfo`；只输出设备 ID、设备类型、MAC、系统版本的存在性和长度，不输出原值 |
| `phone_bt_scan` / `scan_phone_bt` / `probe_phone_bt_scan` | 调用 Phone SDK ClassicBT scan，记录发现的设备名和地址后缀，确认 SDK 是否能主动发现眼镜 |
| `phone_bt_connect` / `connect_phone_bt` / `connect_phone_bt_bonded` | 从已配对设备中选择 `Glasses*` / `Rokid*` 候选，调用 Phone SDK `connectToServer`，再重查 BT/Auth 和 `GlassDeviceInfo` |
| `phone_auth_probe` / `phone_auth` / `probe_phone_auth` | 检查手机侧在线语音授权 readiness，只输出 `x-user-authorization`、`x-app-authorization`、`appCredential`、`userCredential` 的存在性和长度 |
| `phone_auth_apply` / `apply_phone_auth` | 不把 AK/SK 放进 `EngineParam`，改为用本机 JWT 生成 app token，再调用 `SecuritySDKEnv.updateDeviceHeaders(...)`；需要先拿到 Phone SDK `GlassDeviceInfo` |
| `phone_init` / `init_phone` | 初始化手机侧 Rokid ASR/TTS WebSocket engine |
| `phone_tts` | readiness 通过后调用手机侧 Rokid `TtsEngine.playTts(text)` |
| `phone_asr_start` / `start_phone_asr` | 启动手机侧 Rokid ASR，并把 CXR PCM 喂入 |
| `phone_asr_stop` / `stop_phone_asr` | 停止手机侧 Rokid ASR |
| `android_voice_probe` / `android_system_voice` / `android_voice_info` | 检查 Android 系统 `SpeechRecognizer` / `TextToSpeech` / 音频设备列表，用作系统语音备用探针 |
| `android_voice_route_bluetooth` / `android_route_bluetooth` / `android_bt_route` | 尝试把手机系统 ASR/TTS 路由到蓝牙通信设备；当前无可用蓝牙通信设备，`scoOn=false`。 |
| `android_voice_clear_bluetooth` / `android_clear_bluetooth` / `android_bt_clear` | 清除手机系统语音蓝牙路由，恢复 `MODE_NORMAL`。 |
| `android_headset_voice_start` / `android_bt_headset_voice` / `android_headset_voice` | 尝试通过 Android `BluetoothHeadset.startVoiceRecognition()` 拉起 HFP/HEADSET 语音通道；当前 `Glasses_3268` 只在 bonded 里，`headsetState=disconnected`，返回 `false`。 |
| `android_headset_voice_stop` / `android_bt_headset_voice_stop` | 停止 Android `BluetoothHeadset.stopVoiceRecognition()` 并清理系统语音蓝牙路由。 |
| `android_tts` / `android_system_tts` | 调 Android `TextToSpeech.speak(text)`，等待 `onStart` / `onDone` / `onError` |
| `android_asr_start` / `start_android_asr` | 调 Android `SpeechRecognizer.startListening()`，收集 partial/final/error |
| `android_asr_stop` / `stop_android_asr` | 停止 Android 系统 ASR 会话 |
| `android_asr_tts_loop` / `android_loopback` / `android_voice_loopback` | 先启动 Android 系统 ASR，再用系统 TTS 播测试文本，验证系统 ASR/TTS 回环是否能拿到 final 文本 |

`native_voice_command` 是真实命令入口。`ping/status/diag/asr_start/asr_stop/tts/echo_start` 会通过 CXR CustomCmd 发给眼镜测试 APK；其中 `status/diag` 也会并行通过 Phone SDK P2P/ClassicBT 发一份，方便区分 CXR 和 Phone SDK 消息通道。`phone_*` 走手机侧 Rokid Phone SDK 在线语音引擎。当前 UI 会动态隐藏 `phone_init`、`phone_asr_start`、`phone_tts`，直到 `phone_auth_probe` 显示 `ready=true`；未 ready 时 ADB 直接记录 `Phone SDK ASR/TTS probe not ready`，不再发起必然超时的 WebSocket 连接。`phone_bt_scan` / `phone_bt_connect` / `phone_bt_auth` 用来诊断 Phone SDK ClassicBT message/auth 通道；`phone_device_handshake` 用来诊断 Phone SDK 设备服务消息通道；`phone_device_info` 用来单独验证 Phone SDK 是否已经缓存 `GlassDeviceInfo.deviceId`；`phone_auth_apply` 是当前新增的安全激活路径：不使用会打印 AK/SK 的 SDK `GenerateSignedToken`，而是在本 App 内生成同结构 JWT；仍要求本机已配置 AK/SK 且 Phone SDK 已缓存 `GlassDeviceInfo.deviceId`。`native_voice_mode` 只用于本地注入回调和自测。

2026-07-05 真机诊断结论：

| 项 | 结果 |
| --- | --- |
| 手机 APK 安装 | `app-debug.apk` 已安装到 `<adb-serial>` |
| CustomApp 会话 | `connect_glass_app` 返回 `customAppReady=true` |
| 眼镜测试 APK | 提升 versionCode 后，增强版 `status/diag` 已生效；后续同包覆盖可能被眼镜侧安装器拒绝，需要继续用 versionCode 递增或官方卸载入口 |
| 消息通道 | `status` 和 `diag` 均能收到 `RABI_STATUS` 回包 |
| 眼镜设备 | `Rokid/RG-glasses/sdk32` |
| 可见系统包 | 能看到 `com.rokid.cxrservice`、`com.rokid.os.sprite.*` 等 CXR/sprite 包 |
| Glass SDK Security Service | `com.rokid.security.system.server` / `com.rokid.security` / `com.rokid.glass.service` 等候选包均不可见 |
| 原生 ASR/TTS | `ready=false;asr=false;tts=false;message=false;serviceConnected=false;serverPackage=false` |

当前判断：CXR/CustomApp 消息和 GUI 能用，但这台 `RG-glasses` 环境没有暴露 Glass SDK `Security Service`，所以 `GlassSdk.getGlassAsrService()` / `getGlassTtsService()` 不能作为可用原生 ASR/TTS 路线验收。

`android_*` 命令不走 Rokid SDK。它们只回答 Android 系统层是否可用：`android_tts` 真机已收到 `onDone`；给 `com.xiaomi.mibrain.speech` 补麦克风权限后，`android_asr_tts_loop` 已收到非空 ASR final 文本。

脚本 summary 的 `results.androidSystemAsrFinalText` 是当前最适合消息端接入的结构化字段；logcat 中的 `RABI_ANDROID_ASR:<text>` 是最低成本实时监听口。

## 真机测试顺序

1. 安装并打开手机 APK。
2. 点 `Android 权限`，允许蓝牙、附近设备、麦克风、相机等权限。
3. 点 `Rokid 授权` 获取 token。
4. 点第 07 卡片的 `连接应用会话`。
5. 点 `查询安装`。
6. 如未安装，点 `安装眼镜 APK`。
7. 点 `启动眼镜 APK`。
8. 点 `Ping 眼镜`，确认 `message=是`。
9. 点 `远程开始 ASR`，看是否出现 `RABI_ASR_START_OK:started`。
10. 对眼镜说话，看手机是否收到 `RABI_ASR:<text>`。
11. 在 TTS 输入框里填入要播报的文本，点 `发送 TTS 测试`，确认眼镜是否播报，并看手机是否收到 `RABI_TTS_OK:<text>`。
12. 点 `远程停止 ASR`，确认 `RABI_ASR_STOP_OK:stopped`。

如果手机 UI 授权不方便，可以用 ADB 先授予手机 APK 的运行时权限：

```powershell
$adb = ".\out\tools\android-sdk\platform-tools\adb.exe"
& $adb -s <adb-serial> shell pm grant com.rabi.link android.permission.RECORD_AUDIO
& $adb -s <adb-serial> shell pm grant com.rabi.link android.permission.CAMERA
& $adb -s <adb-serial> shell pm grant com.rabi.link android.permission.BLUETOOTH_CONNECT
& $adb -s <adb-serial> shell pm grant com.rabi.link android.permission.NEARBY_WIFI_DEVICES
& $adb -s <adb-serial> shell pm grant com.rabi.link android.permission.POST_NOTIFICATIONS
```

部分 Android 系统不支持 `pm check-permission`，readiness 脚本会回退解析 `dumpsys package com.rabi.link` 里的 `runtime permissions`，以 `granted=true` 作为复核依据。

最小消息端闭环测试：

1. 确认 `message=是`。
2. 点 `ASR 回声测试`。
3. 对眼镜说一句话。
4. 手机收到 `RABI_ASR:<text>` 后会自动发送 `RABI_TTS:我听到了：<text>`。
5. 眼镜应播报回声文本，手机固定日志应出现 `ASR 回声测试发送 TTS` 和 `RABI_TTS_OK:<text>`。

## 真机验收口径

原生 ASR/TTS 接入完成需要同时满足：

| 要求 | 完成证据 |
| --- | --- |
| 手机 APK 能安装、启动、授权、进入 CustomApp 会话 | 页面日志和 `ProbeResult` |
| 眼镜 APK 能安装并启动 | `onInstallAppResult=true` / `onOpenAppResult=true` |
| 手机到眼镜消息可达 | `RABI_PONG:` |
| 眼镜端 ASR 能启动 | `RABI_ASR_START_OK:started` |
| 眼镜端 ASR 能返回文本 | `RABI_ASR:<非空文本>` |
| 眼镜端 TTS 能被手机触发 | 眼镜实际播报，且手机收到 `RABI_TTS_OK:<text>` |
| ASR/TTS 可组成消息端闭环 | `ASR 回声测试` 中手机收到 ASR 文本后自动触发 TTS，眼镜实际播报 |
| 失败时有明确原因 | `RABI_*_ERR:<reason>` 写入固定日志和能力状态 |
| 没有任何眼镜回包时可诊断 | 手机侧 7 秒超时后写入 `眼镜原生语音回包超时` |
| 手机侧 SDK 无授权或无回调时可诊断 | 7 秒超时后写入 `手机侧 Rokid 语音引擎超时` 并销毁 ASR/TTS engine |
| 无崩溃 | logcat 无 `AndroidRuntime` / `FATAL EXCEPTION` |

在没有真实 Rokid 眼镜回环验证前，本能力仍处于“协议和探针已实现，真机 ASR/TTS 待验收”状态。
