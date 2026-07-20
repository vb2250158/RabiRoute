---
name: benchmark-rabispeech-models
description: 运行或更新 RabiSpeech 本机语音模型闭环基准。用于新增、替换或比较本地 TTS / ASR 模型，测试首请求、加载、预热、热态耗时、RTF、显存、波形和 CER，并从统一公开语料生成 JSON、CSV 及 RibiWebGUI 内可查看的 HTML 报告；也用于维护 TTS / ASR 功能支持矩阵和硬件建议。不得为基准调用已归档云 API。
---

# RabiSpeech 模型闭环基准

把脚本当执行器，把本 skill 当顺序和口径。项目根目录记为 `<repo>`。

## 固定边界

- 只测试已安装、已缓存的本地模型；不启用、恢复或调用云 API。
- 按 `TTS -> WAV -> ASR` 顺序执行。每个 ASR 必须识别每个 TTS 的同一批音频。
- 复用 `plugin-adapters/rabi-speech/benchmarks/cases.zh-CN.json`；除非测试目标就是语料版本升级，不为某个模型临时换题。
- 原始 WAV、worker 日志和 JSON 放在插件 `output/benchmarks/<date>-<name>/`，不要提交。
- 公开 HTML 不写 token、参考音路径、角色私有资料、模型缓存路径或运行期绝对路径。

## 1. 准备运行目录

创建一个新的基准目录，复制或直接引用固定语料。先记录测试机的 OS、CPU、RAM、GPU、驱动、模型版本和实际 execution provider，并更新 `benchmarks/report-metadata.json`。

确认要测的 TTS worker 已经在本机回环地址运行。冷启动比较需要显式重启对应 worker；如果测试前已经 ready，必须把首条标为 `already-warm`，不能冒充冷启动。

## 2. 先测试每个 TTS

对每个 worker 各执行一次：

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\benchmark_models.py tts `
  --engine <stable-engine-id> `
  --url http://127.0.0.1:<worker-port> `
  --texts plugin-adapters\rabi-speech\benchmarks\cases.zh-CN.json `
  --output <run-dir>\tts-<stable-engine-id>.json `
  <voice-or-reference-options>
```

使用稳定、公开的 engine id。角色参考音只作为本机参数传入，不复制进报告目录。检查每个结果都有三条记录、三个 WAV、音频时长、RTF、RMS、削波率和 GPU 采样。

## 3. 再测试每个 ASR

选择一条固定短句 WAV 做不计分预热；默认用 ONNX-VITS 的 `short-dialogue`。每个 ASR 都传入全部 TTS 结果：

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\benchmark_models.py asr `
  --model <cached-model-id> `
  --model-root <local-model-cache> `
  --tts-results <run-dir>\tts-onnx-vits.json `
  --tts-results <run-dir>\tts-qwen3-tts-0.6b.json `
  --tts-results <run-dir>\tts-indextts2.json `
  --warmup-audio <run-dir>\audio\onnx-vits\01-short-dialogue.wav `
  --output <run-dir>\asr-<cached-model-id>-warm.json
```

保持 `local_files_only` 语义。若模型未缓存，列为“支持但未测试”，不要为一次报告自动下载。确认结果包含模型加载、预热、正式逐句转写、CER、耗时和 RTF。

## 4. 汇总和生成 HTML

先用 `summarize` 生成 `summary.json` 与三张 CSV，再用 `render-html` 生成 RibiWebGUI 的公开报告：

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\benchmark_models.py render-html `
  --summary <run-dir>\summary.json `
  --texts plugin-adapters\rabi-speech\benchmarks\cases.zh-CN.json `
  --metadata plugin-adapters\rabi-speech\benchmarks\report-metadata.json `
  --template plugin-adapters\rabi-speech\benchmarks\report-template.html `
  --tts <each-tts-json> `
  --asr <each-asr-json> `
  --output ribiwebgui\public\reports\rabispeech-model-benchmark.html
```

HTML 必须至少呈现：

- 测试文本与闭环顺序。
- TTS 功能矩阵、首请求、热态耗时、RTF、显存和柱状图。
- ASR 功能矩阵、加载、预热、热态耗时、总体 CER 和柱状图。
- ASR 按 TTS 来源分组的 CER，以及逐句参考文本 / 识别文本 / CER 表。
- 测试硬件、最低 / 建议配置、历史归档模型、方法和限制。

## 5. 新增模型

新增 TTS 时：先在 `report-metadata.json.tts_models` 增加功能说明，再生成一个新的 `tts-*.json`，并让所有 ASR 重跑包含它的输入集合。

新增 ASR 时：先在 `report-metadata.json.asr_models` 增加功能说明，再让它识别所有现有 TTS 音频。不要只测最容易识别的一种声线。

脚本和模板按数据数组渲染；不要为每个模型硬编码新表格或新柱形。

## 验收

```powershell
py -3.10 -m py_compile plugin-adapters\rabi-speech\scripts\benchmark_models.py
py -3.10 plugin-adapters\rabi-speech\scripts\benchmark_models.py --help
node skills\audit-rabiroute-public-docs\scripts\audit-public-docs.mjs
npm run relay:rabilink:webgui:check
npm run webgui:build
```

然后打开：

```text
http://127.0.0.1:8790/#/docs
http://127.0.0.1:8790/#/speech
http://127.0.0.1:8790/reports/rabispeech-model-benchmark.html
```

检查“语音服务”的实时模型与目标测试机报告，以及使用手册中的“从远端调用 TTS 与 ASR”。确认表格、柱状图、逐句结果、移动端横向滚动和独立报告链接都可用。

如果有真实 Relay 验收环境，还要登录并打开：

```text
https://<relay>/manage/<account>/<RabiGUID>/#/speech
https://<relay>/manage/<account>/<RabiGUID>/reports/rabispeech-model-benchmark.html
```

远端报告必须返回 `200` 和 `text/html`。没有公网环境时，只能记录“本地报告与 Relay 静态契约已验证”，不能写成真实公网已通过。
