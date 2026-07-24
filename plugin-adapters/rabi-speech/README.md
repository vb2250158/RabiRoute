<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiSpeech 插件

RabiSpeech 是 Rabi 的独立本机服务插件，也是只绑定回环地址的本地 TTS / ASR provider 网关。普通手动语音 API 不接入 Agent、不经过消息路由；常驻麦克风每完成一段 ASR，Manager 会把同一份文本广播给所有已开启语音消息端的 Route，各 Route 独立执行热投递或人格关键词策略：

- TTS 由 RabiSpeech 直接管理本地 ONNX-VITS、GPT-SoVITS、IndexTTS2、Qwen3-TTS 和 CosyVoice3 worker。
- ASR 支持本地 faster-whisper、Qwen3-ASR、SenseVoiceSmall 和 FireRedASR2。
- Rabi 人格拥有 `data/roles/<RoleId>/voice/` 参考音频、voice index 和缓存；直接把人格目录名作为 `voice` 即可，无需 Route 或 Agent。
- 所有模型、人格、Route、会话和 Agent 的播放统一进入一个主机级 FIFO。
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
GET  /v1/models/{provider}/{model}
GET  /v1/capabilities
GET  /v1/records
GET  /v1/speaker-profiles
PUT  /v1/speaker-identities
PUT  /v1/speaker-bindings
GET  /v1/microphone/status
GET  /v1/microphone/devices
POST /v1/audio/speech
POST /v1/audio/transcriptions
POST /v1/microphone/start
PUT  /v1/microphone/settings
POST /v1/microphone/stop
GET  /v1/playback/status
PUT  /v1/playback/settings
POST /v1/playback/stop
```

`/v1/microphone/*` 是主机设备控制面，只供回环 RabiPC/Manager 使用，不在 RabiLink 公网语音 allowlist 中。启动后录音流由 RabiSpeech 进程持有；关闭浏览器不会停止。`microphone.json` 持久保存主机设备、阈值、ASR 模型和内部会话；旧 `route_id` 会迁移为 `null`。Manager 根据 Route 订阅协调启停：任意订阅存在时保持监听，最后一个订阅关闭后才停止。运行中可通过 `PUT /v1/microphone/settings` 更新并恢复监听。

局域网远程音频是独立的网络声卡通道。启用 `remote_audio` 后，轻量 Windows 客户端通过 TCP `8782` 持续上传 16 kHz 单声道 PCM，并接收主机 FIFO 下发的 WAV；UDP `8783` 只用于同网段发现。客户端不执行 VAD、切句、ASR、TTS 或 Route 投递。音频流选择由回环接口 `GET /v1/audio-streams` 与 `PUT /v1/audio-streams/selection` 管理，默认是本机，远程端断线时不静默回退。安装见 [`../../desktop/rabi-voice-client/README.md`](../../desktop/rabi-voice-client/README.md)。RabiLink 不是这条局域网链路的配置依赖。

控制面状态通过回环 SSE `GET /v1/events` 推送。Manager 将它转发为 `GET /api/speech/events`；`microphone_event`、`playback_changed`、`audio_stream_changed` 分别刷新对应状态，`records_changed` 只在 ASR/TTS 记录成功落盘后刷新记录面板，麦克风电平使用限频的 `microphone_level` 直接更新。SSE 重连只做一次快照补漏，不运行固定间隔状态或记录轮询。

`PUT /v1/playback/settings` 同样只允许回环调用，接受 `{"volume": 0..100}`。它是主机级唯一播放音量，持久化在忽略 Git 的 `output/playback-settings.json`，不属于 Route 或人格；每条 FIFO 音频开始播放时冻结当时的数值。Windows 播放统一使用 SoundFile / PortAudio，能正确读取流式 WAV 的实际数据长度。Windows 11 音量合成器按进程映像显示应用，因此 `scripts/install.ps1` 会生成并由 `scripts/start.ps1` 优先启动带 RabiSpeech 产品资源的 `runtime/RabiSpeech.exe`。服务启动时建立一个持续无声的共享输出会话，把历史 `1%` 只归一一次到 `100%`，之后只保活、不回写，保证 Windows 合成器滑条一直可调。该无声会话不进入 FIFO，也不触发麦克风防回流。

DashScope 风格兼容面：

```text
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

TTS 示例：

```powershell
$body = @{
  model = "local-tts/gpt-sovits"
  input = "这是本机语音服务。"
  voice = "Rabi"
  response_format = "wav"
  sample_rate = 16000
  speed = 1.0
  play = $false
} | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:8781/v1/audio/speech `
  -ContentType "application/json" -Body $body -OutFile .\output.wav
```

当输入与输出都是 WAV 时，`sample_rate` 由 RabiSpeech 的统一音频准备层使用 NumPy + SoundFile 在本地完成重采样，不依赖 ffmpeg。WAV 转 MP3、FLAC、Opus、AAC、PCM 等跨格式转换仍需配置 `server.ffmpeg` 或 `RABISPEECH_FFMPEG`。

ASR 示例：

```powershell
curl.exe -X POST http://127.0.0.1:8781/v1/audio/transcriptions `
  -F "file=@sample.wav" -F "model=asr-local" -F "response_format=verbose_json"
```

DashScope 风格 ASR 为了保持本地隐私，只接受 `data:audio/...;base64,...`，不会替调用方下载任意公网 URL。

## 语音记录与 TTS 缓存

常驻麦克风完成一段语音后计算整段 RMS 与峰值，并把它们随采集时间、音频格式、来源设备和 ASR/声纹分段提交给 Manager。主机通用记录、人格语音历史和会话上下文都会保留这两个音频事实，但主机不据此判断说话人身份或谁是用户。关闭前置缓冲时，触发 VAD 的第一块 PCM 仍属于语段，不能吞掉句首。

`GET /v1/records` 查询按日期持久化的 ASR/TTS 文本元数据，可按 `kind`、`session_id`、`route_id` 和时间窗口筛选。文本记录与成品音频缓存彼此独立；音频超过保留窗口不会删除文本记录。

解析到人格的 TTS 成品固定保存在对应的 `data/roles/<RoleId>/voice/cache/tts-audio/`。`server.tts_audio_dir`（或 `RABISPEECH_TTS_AUDIO_DIR`）只控制未解析到人格时的 fallback，默认物理位置是 `plugin-adapters/rabi-speech/output/tts-audio/`，不能把人格缓存重定向出角色目录。

每个成品文件按自己的 mtime 默认保留 `1440` 分钟（24 小时），不按自然日整批删除。服务启动时清理已过期文件并计算最早到期时间；每次写入新 TTS 成品只在它更早到期时重排一个一次性 cleanup deadline，不再每 60 秒扫描全部人格与 fallback 缓存。进程停机和操作系统调度仍可能让实际删除晚于预计时间，因此记录中的预计过期时间不是硬实时承诺。

记录 API 只返回安全的 POSIX 风格逻辑相对路径：人格缓存为 `<RoleId>/voice/cache/tts-audio/<file>`，fallback 为 `output/tts-audio/<file>`；旧记录可保留单个文件名。绝对路径、父级穿越、反斜杠、URI/编码伪路径和控制字符不会进入 Manager/WebGUI read model。

## 说话人标注

说话人资料与 `record_id + speaker_label` 绑定共用主机级 `output/speaker-profiles.json`。供应商的 `0/1`、`Speaker 1/2` 只在单次 ASR 录音内有效，绝不按常驻麦克风 `session_id` 继承。人工入口位于 RabiPC「语音服务 → ASR → 说话人 / 声纹设置」；未知和已知说话人分别折叠展示，每个录音分段可通过下拉确认或纠正。

Agent 可调用 `PUT /api/speech/speaker-identities`，本机调用方也可使用 `PUT /v1/speaker-identities`，并同时传入 `sessionId/session_id`、`recordId/record_id` 与 `speakerLabel/speaker_label`。接口在一次幂等事务中按人物 ID 复用，或按显示名/别名查找、创建、合并别名并只绑定当前录音标签。下拉确认会同时把该录音的本地 embedding 标为已确认原型，后续录音再按多原型相似度、第一/第二名差距和有效语音时长共同判定；低置信度仍留在未知聚类，不会强认。

默认首选 3D-Speaker ERes2NetV2 中文 16k，备选 CAM++。模型和依赖都只在本机使用，原始注册音频不会复制；embedding 保存在 Git 忽略的 `output/speaker-embeddings.json`，不会通过 Manager/WebGUI 返回。安装模型需由用户显式执行 `scripts\install_models.ps1 -Model speaker-eres2netv2-zh`（约 68 MiB）；安装前服务保持手工下拉模式。模型存在但 `speaker_recognition.validated=false` 时，默认只做未知聚类和候选提示；只有本机显式设置 `experimental_auto_assign=true` 才会允许带明确实验标记的自动匹配，但仍不声明 `voiceprint.supported=true`。完成同人/异人基准并校准阈值后才把 `validated` 改为 `true`。

可用配置真源直接运行隔离推理探针，避免手工解析相对模型路径：`py -3.10 scripts\speaker_model_probe.py --config config.json`。脚本会从自身位置加载 RabiSpeech 与私有依赖，不依赖调用者当前工作目录。探针成功只证明模型、特征管线和 ONNX Runtime 能输出 embedding，不等于通过真实多人校准。

启动时会先在独立子进程中用 ONNX Runtime + kaldi-native-fbank 对官方 3D-Speaker 模型完成一次真实 embedding 推理。模型格式或 runtime 不兼容时，探测进程可以失败，但 RabiSpeech 主服务必须继续在线并通过 capability 返回具体原因；不得让实验性声纹模型拖垮 TTS、ASR、麦克风或人工绑定。`max_samples_per_profile` 限制每个人工确认人物保留的原型数，`max_unconfirmed_samples` 限制尚未人工确认的聚类/匹配样本总量；过低 RMS 的帧和明显跨说话人重叠的片段不会进入声纹样本。

声纹匹配不等于说话人分离。ASR 至少要返回可靠的 `start/end` turn 边界，RabiSpeech 才能分别提取多人 embedding；Provider 的 `speaker` 标签可以不可靠，同一标签出现在多个不连续 turn 时，声纹层会保留原始 `speaker`，同时生成逐 turn 的 `speaker_label` 并独立聚类，从而允许声纹纠正 Provider 合并。普通 ASR 没有时间分段时，一次 VAD 切片仍按单个临时 `voice` 处理，不能识别同一切片中的轮流或重叠说话。

`scripts/benchmark_speaker_models.py` 使用同一批私有 WAV 评估选定的本地声纹模型，并可选加入旧 68 维频谱基线作历史比较，输出 EER、FAR、FRR、已知人物识别率、未知保留率与 p50/p95 延迟。语料清单格式见 `benchmarks/speaker-cases.example.json`；真实录音必须留在 Git 忽略目录，不进入公开报告。脚本和模型探针一样会从自身位置加载 RabiSpeech 与 `.deps`，因此可直接从仓库根目录或任意工作目录运行，不需要人工设置 `PYTHONPATH`。

正式校准前可用采集工具建立私有数据集。默认目录是已被 Git 忽略的 `benchmarks/private/speaker-validation/`；工具只写 WAV、原子更新 `speaker-cases.json` 并把旧 manifest 归档到同目录 `archive/`，不会修改人物资料、人格关系或 `validated`。新建、旧版或未声明的数据集默认是 `dataset_kind=unspecified`、`formal_validation_eligible=false`；只有确认目录内全部样本都是真人录音后，显式执行 `init --confirm-real-person-recordings`，才会标记为 `real_person_private`。录音统一为 16 kHz 单声道，低 RMS、短于 1 秒或严重削波默认拒绝：

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py init `
  --confirm-real-person-recordings
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py devices
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py record `
  --speaker user-a --role enroll --count 3 --seconds 5
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py record `
  --speaker user-a --role test --count 3 --seconds 5
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py add `
  --speaker unknown-a --role test --file <private-wav>
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py status `
  --policy plugin-adapters\rabi-speech\benchmarks\speaker-validation-policy.example.json
```

公开示例 policy 的最低规模是 32 段、4 个已登记人物、至少 2 个未知测试人物；建议每个已登记人物分别采 3 段 enroll 和 3 段 test，再为两个未知人物各采 4 段 test，并覆盖实际使用的电脑、手机/眼镜麦克风、距离和房间噪声。`speaker` 是私有数据集标签，不会自动成为人格所理解的用户身份。

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\benchmark_speaker_models.py `
  --manifest plugin-adapters\rabi-speech\benchmarks\private\speaker-validation\speaker-cases.json `
  --model 3dspeaker-eres2netv2-zh-16k=<absolute-model.onnx> `
  --threshold 0.72 --margin 0.06 `
  --policy <private-policy.json> --require-pass `
  --output <private-validation-report.json>
```

正式校准时复制并按真实麦克风、房间、人群和风险容忍度调整 `benchmarks/speaker-validation-policy.example.json`，然后同时传入 `--policy <private-policy.json> --require-pass`。门禁会检查真人数据集资格、语料规模与全部准确率指标，并在报告中证明 dataset manifest SHA-256、policy SHA-256、模型 SHA-256、hard threshold、min margin 与目标引擎 policy 结果；合成 TTS、旧 manifest、未显式确认真人录音或任一指标失败时仍保存报告，但退出码为 `2`。通过后必须把报告配置到 `speaker_recognition.validation_report_path`，再设置 `validated=true`；运行时会重新核对这些证明字段，不再信任一个孤立布尔值。

## TTS → ASR → 声纹事件烟测

`scripts/test_multivoice_voiceprint.py` 用于“多个 TTS 声音合成到同一个 WAV”的声纹预检。它既可通过重复 `--source 匿名标签=<tts-wav>` 接收现有音频，也可通过重复 `--tts-voice` 让已经运行的 RabiSpeech 自己生成匿名 `source-N.wav`。脚本统一为 16 kHz 单声道、插入短静音并记录显式合成边界，再让真实本机声纹模型逐边界提取。可选 `--asr-model` 会把同一组合 WAV 交给真实会议 ASR，按 ASR 自己返回的时间段再次检查声纹；Provider 即使复用了 speaker 标签，只要保留了独立 turn，声纹层仍可拆出不同 voiceprint。时间段或声纹数量不足预期时才失败并退出 `2`。报告只保留来源 SHA-256、匿名序号、模型、响度、判定与数量，不保存测试正文、声音名、绝对路径或原始声纹 ID。显式边界不等于 ASR 自动 diarization，报告固定 `formalValidationEligible=false`：

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\test_multivoice_voiceprint.py `
  --source voice-a=<tts-a.wav> `
  --source voice-b=<tts-b.wav> `
  --source voice-c=<tts-c.wav>

py -3.10 plugin-adapters\rabi-speech\scripts\test_multivoice_voiceprint.py `
  --tts-model dashscope-qwen/qwen3-tts-instruct-flash `
  --tts-voice <voice-a> --tts-voice <voice-b> --tts-voice <voice-c> `
  --asr-model dashscope-qwen/paraformer-v2 --speaker-count 3
```

自动生成模式只调用回环 RabiSpeech 标准 API，不自行复制 Provider 协议；因此外部模型仍必须先在本机私有配置中显式启用。脚本会先查询 `/v1/models`，完整模型 ID 可直接使用，唯一的短模型名会解析到当前完整 ID；短名在多个 Provider 中重名或当前不可用时明确失败，不会把猜测的旧 ID 直接提交。TTS 与 ASR 请求都等待当前请求的终态，不运行状态轮询；DashScope 异步会议任务仅在 Provider 的请求 deadline 内保留受控查询。

仓库根目录的 `scripts/test-rabispeech-tts-loop.mjs` 把一次真实闭环收敛成可复现验收。它要求 RabiSpeech 与 Manager 已经运行，先订阅 SSE `records_changed`，再按 `/v1/models` 的真实能力生成 16 kHz mono WAV、把同一 WAV 送入 ASR、检查不透明声纹证据，最后各查询一次 RabiSpeech 与 Manager 的同会话 TTS/ASR 记录。脚本不启动或停止服务/麦克风、不播放音频、不调用 `/api/speech/messages`，因此不会投递 Route 或修改人格关系；查询发生在两个终态事件到达之后，不做状态或记录轮询。

自动选模优先选择已安装可用的本地 Provider。只有显式加 `--allow-api-provider` 才允许使用配置中已经启用的 HTTPS API Provider，不会在本地失败后暗中回退云端：

```powershell
npm run check:rabispeech:tts-loop

npm run check:rabispeech:tts-loop -- `
  --tts-model dashscope-qwen/qwen3-tts-instruct-flash `
  --asr-model dashscope-qwen/paraformer-v2 `
  --allow-api-provider
```

脱敏报告和 WAV 默认写入 Git 忽略的 `plugin-adapters/rabi-speech/output/acceptance/`。报告不保存测试正文、声线/人格值或原始声纹 ID，只保存哈希、模型、音频指标、事件与查询检查；固定标记 `datasetKind=synthetic_tts_smoke`、`formalValidationEligible=false`。它只证明运行机制，不能写入 `validation_report_path`，也不能替代真人校准。

构建后还可运行 `npm run check:speech-ingress-separation`。它不调用模型，而是在临时数据根中用真实 `dist/index.js --speech-message` 分别处理 PC `speech` 与手机 `rabilink` 主机记录，验收一个通用主机库、两个不同人格的独立历史、主机身份字段清洗，以及手机回复只使用稳定设备 ID。它不访问真实 Manager、Desktop、QQ、Relay、麦克风或人格目录，和上面的模型闭环烟测分别证明“语音模型链”和“消息/人格路由链”。

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
