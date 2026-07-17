# RabiSpeech 本机 TTS / ASR 插件

RabiSpeech 是 Rabi 的独立语音基础设施插件。它提供普通 HTTP TTS / ASR API，不接入 Agent，不读取人格、上下文或消息路由，也不会把本机端口直接暴露到公网。

```text
任意 HTTP 客户端
  -> RabiLink Relay（应用 token 鉴权、选定 PC、短时内存队列）
  -> Manager 主动领取请求
  -> 127.0.0.1:8781 RabiSpeech
  -> 本地 TTS / ASR provider
  -> 原 HTTP 请求返回最终音频或转写
```

调用方只看到一次同步 HTTP 调用。内部的领取、租约和回传是 Relay 与 Manager 的实现细节，调用方不需要创建任务或轮询。

## 组件边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| RabiSpeech | API 契约、鉴权、上传限制、provider 选择、格式转换 | Agent、消息路由、服务器账号 |
| TTS / ASR provider | 调用一个已安装的本地模型或本地服务 | 公网鉴权、中转、远程安装模型 |
| Manager Relay runtime | 主动领取并代理原始 HTTP 请求/响应 | 理解音色、正文或模型语义 |
| RabiLink Relay | 应用 token、选定 PC、短时请求协调 | 持久保存音频、运行模型、解析正文 |

当前内置 provider：

- TTS：`oumuq`，复用本机 OumuQ 的角色和 worker 能力。
- ASR：`faster-whisper`，默认复用 FenneNote 的本地 `small` 模型缓存。

## 本机安装

```powershell
cd plugin-adapters\rabi-speech
.\scripts\install.ps1
.\scripts\test.ps1
.\scripts\start.ps1
.\scripts\install-service.ps1 -StartNow
```

默认只监听 `http://127.0.0.1:8781`。首次启动会生成被 Git 忽略的 `config.json`。`install-service.ps1` 注册当前用户登录触发的 `RabiSpeech` 计划任务，因此可以使用当前用户的 NAS 访问权限；不注册 SYSTEM 服务。本机回环链路不再设置第二个 token；所有公网 TTS / ASR 接口统一使用 RabiLink 应用 token。

## 开启 RabiLink 中转

在 RibiWebGUI 概览页保存：

- 开启 RabiLink Relay，并填写服务器地址和应用 token。
- 开启“允许语音中转”。
- 本机语音服务地址保持 `http://127.0.0.1:8781`。

Manager 只允许回环地址，不能借此把代理改指向内网或公网服务。服务器只会选择该应用当前选中的、在线且显式声明 `speech` capability 的 PC。

## 直接 API

公共基址：

```text
https://<relay>/api/rabilink/speech
```

鉴权任选一种：

```http
Authorization: Bearer <RabiLink 应用 token>
```

```http
X-RabiLink-Token: <RabiLink 应用 token>
```

浏览器的 `OPTIONS` CORS 预检不需要 token；所有实际 `GET` / `POST` 请求仍要求应用 token。

TTS：

```bash
curl -X POST "https://<relay>/api/rabilink/speech/v1/audio/speech" \
  -H "Authorization: Bearer <app-token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-local","input":"你好，这是本机语音。","voice":"default","response_format":"wav"}' \
  --output speech.wav
```

ASR：

```bash
curl -X POST "https://<relay>/api/rabilink/speech/v1/audio/transcriptions" \
  -H "Authorization: Bearer <app-token>" \
  -F "file=@sample.wav" \
  -F "model=asr-local" \
  -F "language=zh" \
  -F "response_format=verbose_json"
```

可发现接口：

```text
GET /health
GET /v1/models
GET /v1/capabilities
GET /openapi.json
```

兼容阿里云 DashScope 风格的别名：

```text
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

这些别名保持本机同步执行。ASR 兼容别名只接受 `data:audio/...;base64,...`，不会根据远程输入下载任意 URL；普通 ASR 推荐使用 multipart 端点。

## Provider 扩展

provider 是插件内部的扩展点，不是 Agent adapter。新增 provider：

1. 实现 `TtsProvider` 或 `AsrProvider` Protocol。
2. 提供 `register(registry, settings)` 注册函数。
3. 在本机 `config.json` 的 `providers.extensions` 中加入 `python.module:register`。

```json
{
  "providers": {
    "extensions": [
      "my_rabi_provider:register"
    ]
  }
}
```

扩展列表只能由本机管理员配置。远程请求可以选择已经注册的 provider/model，但不能加载代码、下载模型或改变 provider 清单。provider ID 必须唯一。

适合后续接入的本地实现包括 IndexTTS2、Qwen3-TTS、本地 CosyVoice、SenseVoice、Whisper.cpp 等；它们共享同一套 API、鉴权和 Relay 中转，不需要各自开放公网端口。

## 限制与安全

- 首版是同步直接 API，适合短文本 TTS 和常规音频转写；单请求默认上限 25 MiB、等待 180 秒。
- Relay 中的请求体和响应体只放在短时内存队列，完成、失败或超时后释放；事件日志不记录文本、音频、请求头或响应正文。
- 当前不提供流式音频。长音频与流式 WebSocket 可作为后续独立 transport，不能悄悄改变现有同步接口语义。
- 应用 token 统一用于该应用的 TTS、ASR、模型列表和健康检查；Manager 转发到固定回环地址时会丢弃它，不把公网凭证交给模型进程。
- 一个应用当前只调用它选中的一台 PC；切换 PC 仍由账号管理页完成。

OpenAPI 真源位于 `examples/rabilink-relay/rabilink-speech-api.openapi.json`，Relay 发布为 `/api/rabilink/speech/openapi.json`。

## 模型闭环基准与 HTML 报告

> 适用范围：下列性能与效果只代表报告中标明的目标测试机、当次软件和模型环境。其他电脑的显卡、CPU、内存、驱动和参考音不同，具体结果必须以该电脑重新运行同一套基准为准。

RibiWebGUI 的“项目文档 → 语音服务”包含三个栏目：

- `TTS 语音合成`：本地引擎的定位、功能支持和性能摘要。
- `ASR 语音识别`：本地模型、加载、预热、热态性能和准确率。
- `TTS / ASR 性能报告`：内嵌完整 HTML，也可独立打开。

左侧主导航的“语音服务”是另一层：它通过 Manager 的只读 `/api/speech/status` 安全探测当前电脑的回环 RabiSpeech，实时显示当前 provider、默认模型、CUDA / CPU、加载和预热状态。它不会把本报告的目标测试机模型清单硬编码成每台电脑的现状。

本机入口：

```text
http://127.0.0.1:8790/#/docs
http://127.0.0.1:8790/#/speech
http://127.0.0.1:8790/reports/rabispeech-model-benchmark.html
```

测试固定按下面顺序进行：

```text
公开测试文本
  -> 每个 TTS 各生成 3 条 WAV
  -> 每个 ASR 加载模型
  -> 用 short-dialogue WAV 做 1 次不计分预热
  -> 每个 ASR 识别全部 TTS WAV
  -> 汇总逐句 CER、按 TTS 来源 CER、总体 CER、耗时、RTF、显存
  -> 生成 JSON、CSV 和 HTML
```

固定中文测试用例：

| 类型 | 文本 | 目的 |
|---|---|---|
| 短句 | 你好，这是本地语音服务的速度测试。 | 首请求、基础中文发音和低延迟 |
| 中英混合 | 请提醒我检查 RabiLink 服务器，并确认 ASR 与 TTS 接口正常。 | 产品名、英文缩写和中文混读 |
| 长指令 | 如果网络暂时断开，请保留本地任务，等待连接恢复以后再重试，并把失败原因写进诊断报告。 | 长句停顿、完整性和持续生成 |

2026-07-17 目标测试机统一基准摘要：

| 类型 | 模型 | 加载 / 首请求 | 预热 / 热态 | 性能 / 效果 |
|---|---|---:|---:|---|
| TTS | ONNX-VITS | worker 已常驻；首条 1.40 秒 | 热态均值 1.61 秒 | RTF 0.37；CPUExecutionProvider |
| TTS | Qwen3-TTS 0.6B | 冷首条 10.39 秒 | 热态均值 10.33 秒 | RTF 1.47；small 回译 CER 2.4% |
| TTS | IndexTTS2 | 冷首条 46.04 秒 | 热态均值 6.94 秒 | RTF 1.06；small 回译 CER 15.5% |
| ASR | faster-whisper tiny | 加载 4.41 秒 | 预热 1.52 秒；热态 0.19 秒/条 | 总体 CER 38.9% |
| ASR | faster-whisper small | 加载 8.12 秒 | 预热 1.64 秒；热态 0.23 秒/条 | 总体 CER 22.2% |

可重复资产：

```text
plugin-adapters/rabi-speech/benchmarks/cases.zh-CN.json
plugin-adapters/rabi-speech/benchmarks/report-metadata.json
plugin-adapters/rabi-speech/benchmarks/report-template.html
plugin-adapters/rabi-speech/scripts/benchmark_models.py
skills/benchmark-rabispeech-models/SKILL.md
```

脚本支持 `tts`、`asr`、`export-csv`、`summarize`、`render-html` 子命令。新增 TTS 时先生成它的 WAV，再让全部 ASR 重跑包含这个来源的音频；新增 ASR 时让它识别全部已有 TTS 音频。不要只测最容易识别的一条声线，也不要为报告恢复付费云 API。

## Windows CUDA DLL 与首请求慢问题

### 典型症状

ASR 能在 CPU 工作，但第一次尝试 GPU 时返回：

```text
Library cublas64_12.dll is not found or cannot be loaded
```

`nvidia-smi` 仍可能显示 `CUDA Version: 13.x`。这个数字表示当前显卡驱动最高支持的 CUDA 版本，不代表 Windows 已安装 CTranslate2 需要的 CUDA 12 用户态 DLL。应继续检查：

```powershell
where.exe cublas64_12.dll
where.exe cudnn64_9.dll
Get-ChildItem .deps\nvidia -Filter *.dll -Recurse
```

### 本插件的安装方式

不要从第三方 DLL 下载站单独复制文件。`requirements.txt` 使用 NVIDIA 官方 Windows Python wheels，在插件私有 `.deps` 中安装：

```text
nvidia-cublas-cu12
nvidia-cuda-nvrtc-cu12
nvidia-cudnn-cu12==9.24.0.43
```

重新执行即可安装或修复：

```powershell
.\scripts\install.ps1
```

`scripts/start.ps1` 会在启动 RabiSpeech 前，把 `.deps\nvidia\*\bin` 临时加入该进程的 `PATH`。它不修改系统 PATH，不替换现有显卡驱动，也不要求其它 Python 项目共享这些 DLL。NVIDIA 官方文档同时提供 Windows CUDA Toolkit 安装方式和 cuDNN Python wheel 方式；本插件选择后者以缩小影响范围：[CUDA Windows 安装指南](https://docs.nvidia.com/cuda/archive/12.9.1/cuda-installation-guide-microsoft-windows/index.html)、[cuDNN Windows 安装指南](https://docs.nvidia.com/deeplearning/cudnn/installation/latest/windows.html)、[CTranslate2 安装要求](https://github.com/OpenNMT/CTranslate2/blob/master/docs/installation.md)。

### 预热与验收

模型只在构造阶段成功不代表 CUDA DLL 已经可用于推理；CTranslate2 可能在第一次真正推理时才加载 cuBLAS/cuDNN。因此 `preload=true` 会在服务启动阶段执行一次关闭 VAD 的完整静音推理。健康接口返回后检查：

```powershell
(Invoke-RestMethod http://127.0.0.1:8781/v1/capabilities).providers.asr.'faster-whisper'
```

合格状态：

```json
{
  "loaded": true,
  "loaded_device": "cuda",
  "preload": true,
  "warmup_error": ""
}
```

2026-07-17 本机 RTX 4080 Super 验证基线：5.5 秒中文 WAV 在 CPU 约 23.5 秒；CUDA 冷启动初始化约 30 秒并被移到服务启动阶段；服务 ready 后首个真实请求约 1.9 秒，后续热请求约 0.36 秒。实际速度会随模型、音频长度、beam size 和显卡占用变化。

若 GPU 初始化仍失败，provider 会保留 `warmup_error` 并在真实请求失败后自动重试 CPU，避免 API 完全不可用。排障时不能只看到“转写成功”就认为 GPU 正常，必须同时核对 `loaded_device` 和延迟。
