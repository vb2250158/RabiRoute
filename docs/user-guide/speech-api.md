<!-- docs-language-switch -->
<div align="center">
<a href="./speech-api_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 从远端调用 TTS 与 ASR

这篇指南用于让另一台电脑、手机后端或自动化客户端通过 RabiLink Relay 调用目标 Rabi PC 上的 RabiSpeech。普通 TTS 与文件 ASR 请求直接返回音频或转写，不进入 Agent、人格、Route 或会话账本；Android/眼镜连续 PCM 流是明确例外，目标 PC 完成 ASR 后会自动进入主机语音库和 `rabilink` Route。

> 成熟度：实验。先在受控环境验证模型、超时和公网反代，再接入正式客户端。

## 先选对入口

| 调用位置 | Base URL | 鉴权 | 适用场景 |
| --- | --- | --- | --- |
| Rabi PC 本机 | `http://127.0.0.1:8781` | 无公网 token | 本机脚本、插件排障 |
| 任意远端客户端 | `https://<RELAY_ORIGIN>/api/rabilink/speech` | RabiLink **应用 token** | 手机后端、其他电脑、受控服务 |

不要把本机回环地址复制到另一台设备。不要使用眼镜设备 token 调语音 API；该接口只接受应用 token。

## 远端调用前准备

1. 在目标 Rabi PC 的“Rabi 实例”中连接 Relay。
2. 打开“允许语音中转”，本机语音地址保持 `http://127.0.0.1:8781`。
3. 在 Relay `/manage` 的目标应用中选择这台在线 Rabi PC。
4. 复制该应用的 token。只把它放入当前进程的临时变量或密钥存储，不写进仓库、日志或 URL。

下面命令使用 Windows PowerShell 和系统自带的 `curl.exe`。先设置两个变量：

```powershell
$RelayOrigin = "https://relay.example.com"
$Token = "<RABILINK_APP_TOKEN>"
$SpeechBase = "$RelayOrigin/api/rabilink/speech"
```

把 `https://relay.example.com` 换成真实 Relay HTTPS 根地址，把 `<RABILINK_APP_TOKEN>` 换成应用 token。

## 1. 先确认 PC 和模型在线

```powershell
curl.exe --fail-with-body --silent --show-error `
  "$SpeechBase/health" `
  -H "Authorization: Bearer $Token"

curl.exe --fail-with-body --silent --show-error `
  "$SpeechBase/v1/models" `
  -H "Authorization: Bearer $Token"
```

成功时两条命令都返回 JSON；模型列表来自被选中的那台 PC，而不是 Relay 服务器。

## 2. 生成一段 TTS 音频

```powershell
curl.exe --fail-with-body --silent --show-error `
  -X POST "$SpeechBase/v1/audio/speech" `
  -H "Authorization: Bearer $Token" `
  -H "Content-Type: application/json" `
  --data-raw '{"input":"你好，这是通过 RabiLink 调用的本机语音。","voice":"default","response_format":"wav","sample_rate":16000,"speed":1.0}' `
  --output speech.wav

Get-Item .\speech.wav | Select-Object Name, Length
```

成功判据：HTTP 返回成功，并且 `speech.wav` 的 `Length` 大于 0。WAV 输出的 `sample_rate` 由目标 PC 的 RabiSpeech 本地完成，不要求远端客户端安装 ffmpeg；MP3、FLAC、Opus、AAC、PCM 等跨格式输出仍取决于目标 PC 的 ffmpeg 配置。若要指定模型，先从 `/v1/models` 复制当前 PC 实际提供的模型 ID，再在 JSON 中加入 `model`。

## 3. 把音频交给 ASR

下面直接识别上一步生成的文件：

```powershell
curl.exe --fail-with-body --silent --show-error `
  -X POST "$SpeechBase/v1/audio/transcriptions" `
  -H "Authorization: Bearer $Token" `
  -F "file=@speech.wav" `
  -F "language=zh" `
  -F "response_format=verbose_json"
```

成功时返回包含转写文本的 JSON。`file` 必填；需要指定 ASR 模型时同样先从 `/v1/models` 取得真实 ID。

完成后清除当前 PowerShell 会话中的 token：

```powershell
$Token = $null
```

## 常见错误

| 状态 | 含义 | 恢复动作 |
| --- | --- | --- |
| `401` | 应用 token 缺失、错误或已重置 | 从目标应用重新复制 token，检查请求头 |
| `403` | 使用了设备 token 等不允许的凭据 | 改用应用 token |
| `404` | 路径不在 Relay 语音 allowlist | 核对完整 `/api/rabilink/speech/...` 路径 |
| `409` | 应用没有选择可用 PC，或目标 PC 未启用语音中转 | 在 `/manage` 选 PC，并检查 PC 在线与开关 |
| `413` | 上传超过当前限制，默认 25 MiB | 缩短或压缩音频后重试 |
| `502` | PC 或本机 RabiSpeech 在处理时失败 | 到目标 PC 查看语音服务状态和日志 |
| `504` | 模型冷启动或处理超过 Relay 等待时间 | 先跑健康检查/预热，或调整受控部署的超时 |

公网 allowlist 不包含麦克风启停、人格目录、模型下载或 Python 扩展加载。远端客户端只能调用已允许端点并选择目标 PC 已安装的模型。

## 本机调用怎么改

在目标 PC 本机调用时，把 `$SpeechBase` 改为 `http://127.0.0.1:8781`，并删除 `Authorization` 请求头。其他 OpenAI-compatible 请求体保持相同。

## 查看目标测试机报告

在本机或远端 RibiWebGUI 打开“语音服务”，点击“目标测试机报告”。远端页面会沿当前 `/manage/<账号>/<RabiGUID>/` 前缀打开报告；报告只代表页面标明的测试机，不是当前客户端的实时性能。

## API 参考

- `GET /api/rabilink/speech/health`
- `GET /api/rabilink/speech/v1/models`
- `GET /api/rabilink/speech/v1/capabilities`
- `POST /api/rabilink/speech/v1/audio/speech`
- `POST /api/rabilink/speech/v1/audio/transcriptions`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/start`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/stop`
- `GET /api/rabilink/speech/openapi.json`

前三个流式接口供 Android/眼镜连续传 16 kHz mono PCM 使用。`sequence` 从 1 开始严格递增；VAD、切句、ASR 和声纹均由目标 PC RabiSpeech 完成，15 秒无 PCM 会自动回收。普通人工 TTS/文件 ASR 调用仍使用前面的同步端点。字段、兼容端点和本机扩展边界见 [RabiSpeech 本机 TTS / ASR 服务](../rabispeech-plugin.md)。
