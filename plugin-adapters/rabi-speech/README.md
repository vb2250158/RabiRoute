# RabiSpeech 插件

RabiSpeech 是 Rabi 的独立本机服务插件，也是只绑定回环地址的 TTS / ASR provider 网关。它不接入 Agent、不经过消息路由，也不拥有角色资料和模型权重：

- TTS 交给 OumuQ，RabiSpeech 等待 worker 完成后返回音频文件。
- ASR 由常驻的本地 faster-whisper provider 完成，默认复用 FenneNote 的模型缓存。
- RabiLink Relay 只代理原始 HTTP 请求和响应，不解析角色、声线或转写正文。

## 安装与启动

```powershell
cd plugin-adapters\rabi-speech
.\scripts\install.ps1
.\scripts\start.ps1
```

注册为当前用户登录时自动启动的本机服务插件：

```powershell
.\scripts\install-service.ps1 -StartNow
```

计划任务使用当前用户身份，以便读取 NAS 上的插件和模型；它不使用 SYSTEM 权限，也不会改变 `127.0.0.1` 监听边界。

默认地址：`http://127.0.0.1:8781`。首次启动会从 `config.example.json` 复制本机 `config.json`；后者不提交 Git。

Windows 安装脚本会把 NVIDIA 官方 CUDA 12 cuBLAS / cuDNN 9 Python wheels 放进插件私有 `.deps`，启动时只把对应 `bin` 目录加入 RabiSpeech 进程 PATH，不改系统级 CUDA PATH。若 DLL 或 GPU 运行时不可用，ASR 会记录能力状态并自动降级 CPU。

RabiLink 中转开启后，任意 HTTP 客户端都可以拿应用 token 直接调用：

```text
https://<relay>/api/rabilink/speech/v1/audio/speech
https://<relay>/api/rabilink/speech/v1/audio/transcriptions
```

调用方收到的是本次请求的最终音频或转写结果，不需要感知 PC 内部领取队列。OpenAPI 位于 `https://<relay>/api/rabilink/speech/openapi.json`。

## API

常见兼容面：

```text
GET  /health
GET  /v1/models
GET  /v1/capabilities
POST /v1/audio/speech
POST /v1/audio/transcriptions
```

DashScope 风格兼容面：

```text
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

TTS 示例：

```powershell
$body = @{
  model = "tts-local"
  input = "这是本机语音服务。"
  voice = "default"
  response_format = "wav"
  speed = 1.0
} | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:8781/v1/audio/speech `
  -ContentType "application/json" -Body $body -OutFile .\output.wav
```

ASR 示例：

```powershell
curl.exe -X POST http://127.0.0.1:8781/v1/audio/transcriptions `
  -F "file=@sample.wav" -F "model=asr-local" -F "response_format=verbose_json"
```

DashScope 风格 ASR 为了保持本地隐私，只接受 `data:audio/...;base64,...`，不会替调用方下载任意公网 URL。

## 扩展 provider

1. 实现 `TtsProvider` 或 `AsrProvider` Protocol。
2. 暴露一个 `register(registry, settings)` 函数，在其中注册 provider。
3. 把 `包名.模块名:register` 写入本机 `config.json` 的 `providers.extensions`。
4. provider 只负责模型调用；鉴权、上传大小、API 形状、字幕格式和 Relay 传输仍由框架负责。

扩展模块只会从本机配置加载，远程 API 不能选择或注入 Python 模块。provider ID 必须唯一；模型可使用 `provider/model` 或 `provider:model` 形式显式选择。

模型切换默认受限。远程请求不能让 faster-whisper 静默下载新模型；先在本机配置和安装，再显式开放。

## 模型基准与 HTML 报告

报告结果仅代表报告内“测试硬件”所列目标测试机和当次环境。部署到其他电脑后，应复用同一语料与脚本重测，具体性能以该电脑为准。

项目使用同一个闭环测试脚本先生成 TTS，再把所有 WAV 交给每个 ASR：

```text
benchmarks/cases.zh-CN.json
  -> scripts/benchmark_models.py tts
  -> scripts/benchmark_models.py asr
  -> summarize
  -> render-html
```

固定语料、功能元数据和 HTML 模板位于 `benchmarks/`。完整工作流见 `../../skills/benchmark-rabispeech-models/SKILL.md`，报告说明见 `../../docs/rabispeech-plugin.md`。构建 WebGUI 后打开：

```text
http://127.0.0.1:8790/#/docs
http://127.0.0.1:8790/reports/rabispeech-model-benchmark.html
```

运行期 WAV、JSON、CSV 和日志继续放在被忽略的 `output/benchmarks/`；公开 HTML 只嵌入脱敏后的指标和逐句结果。
