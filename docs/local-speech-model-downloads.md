# RabiSpeech 本地模型逐项下载与安装

本文只覆盖本地模型。付费 TTS/ASR API 已归档；远程请求也不能触发下载、安装或修改模型白名单。

## 1. 目录约定

不要把模型权重、虚拟环境和真实参考音频放进 Git 仓库。以下示例自行替换：

```powershell
$RABI_ROUTE_ROOT = 'C:\Path\To\RabiRoute'
$MODEL_ROOT = 'D:\RabiSpeechModels'
$RUNTIME_ROOT = 'D:\RabiSpeechRuntimes'
New-Item -ItemType Directory -Force $MODEL_ROOT,$RUNTIME_ROOT | Out-Null
```

RabiSpeech 自带逐模型下载器。先安装下载依赖，再查看所有别名：

```powershell
py -3.10 -m pip install -U 'huggingface_hub[cli,hf_xet]'
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --list
```

每次只下载一个模型，便于失败重试和核对磁盘：

```powershell
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" `
  --root $MODEL_ROOT --model <下表别名> --download-timeout 600 --etag-timeout 120 --max-workers 2
```

下载器只负责权重。各模型必须使用独立 Python 环境，不能把 Qwen、GPT-SoVITS、CosyVoice、IndexTTS2、FunASR 和 FireRed 的 torch/transformers/numpy 混装。

## 2. TTS 模型

| 别名 | 本机权重占用 | 适合用途 | 官方来源 |
|---|---:|---|---|
| `tts-qwen3-0.6b` | 约 2.34 GiB | 轻量多语言音色复刻 | [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) |
| `tts-qwen3-1.7b` | 约 4.23 GiB | 更大多语言模型 | [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) |
| `tts-gpt-sovits` | 本机预训练包约 5.13 GiB | 3–10 秒少样本角色复刻 | [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) |
| `tts-indextts2` | 本机 checkpoints 约 8.29 GiB | 中文复刻、情绪与时长方向 | [IndexTTS2](https://github.com/index-tts/index-tts) |
| `tts-cosyvoice3-0.5b` | 约 9.08 GiB | 多语言、指令、流式方向 | [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) |
| 不自动下载 | 本机图约 0.12 GiB | 固定说话人低延迟 ONNX-VITS | 需自备获授权 split-graph 模型包 |

### 2.1 Qwen3-TTS 0.6B

```powershell
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model tts-qwen3-0.6b
git clone https://github.com/QwenLM/Qwen3-TTS.git "$RUNTIME_ROOT\Qwen3-TTS"
py -3.10 -m venv "$RUNTIME_ROOT\Qwen3-TTS\.venv"
& "$RUNTIME_ROOT\Qwen3-TTS\.venv\Scripts\python.exe" -m pip install -U pip
& "$RUNTIME_ROOT\Qwen3-TTS\.venv\Scripts\python.exe" -m pip install -e "$RUNTIME_ROOT\Qwen3-TTS"
```

配置模型 id：`local-tts/qwen3-tts-0.6b-base`。验证时查询 `/v1/models/local-tts/qwen3-tts-0.6b-base`。

### 2.2 Qwen3-TTS 1.7B

复用同一 Qwen3-TTS 代码环境，只单独下载权重：

```powershell
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model tts-qwen3-1.7b
```

配置模型 id：`local-tts/qwen3-tts-1.7b-base`。16 GiB 显存可按需加载，不建议与所有大模型同时常驻。

### 2.3 GPT-SoVITS

```powershell
git clone https://github.com/RVC-Boss/GPT-SoVITS.git "$RUNTIME_ROOT\GPT-SoVITS"
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model tts-gpt-sovits
```

按官方 Windows 安装说明创建 GPT-SoVITS 自己的环境，并把预训练资源放到它的 `GPT_SoVITS/pretrained_models`。另外准备：

- `fast_langdetect` 本地模型，避免推理期联网。
- NLTK 数据并通过 `NLTK_DATA` 指向本地目录。
- 3–10 秒连续、干净、同语言参考片段及准确转写。

RabiSpeech 使用 SoundFile 读取本地 WAV，可避开 TorchCodec/FFmpeg 共享 DLL 不匹配。配置模型 id：`local-tts/gpt-sovits`。

### 2.4 IndexTTS2

```powershell
git clone https://github.com/index-tts/index-tts.git "$RUNTIME_ROOT\IndexTTS2"
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model tts-indextts2
```

官方推荐 `uv`；Windows 不需要 DeepSpeed 时不要安装 `--all-extras`。把下载内容作为 `checkpoints`，并确认 `config.yaml` 存在。配置模型 id：`local-tts/indextts2`。

### 2.5 CosyVoice3 0.5B

```powershell
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git "$RUNTIME_ROOT\CosyVoice"
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model tts-cosyvoice3-0.5b
py -3.10 -m venv "$RUNTIME_ROOT\CosyVoice\.venv"
& "$RUNTIME_ROOT\CosyVoice\.venv\Scripts\python.exe" -m pip install -r "$RUNTIME_ROOT\CosyVoice\requirements.txt"
```

子模块 `third_party/Matcha-TTS` 必须完整。配置模型 id：`local-tts/cosyvoice3-0.5b`。

### 2.6 ONNX-VITS 固定声线

RabiSpeech 只提供 split-graph 运行框架，不分发模型、说话人表或角色录音。准备一个有权使用的模型目录：

```text
model/
  enc_p.onnx
  emb_g.onnx
  dp.onnx
  flow.onnx
  dec.onnx
config.json
```

运行 `scripts/install.ps1` 会安装 `onnxruntime`、`cn2an`、`pypinyin`、`pyopenjtalk-prebuilt`、`Unidecode`、`inflect` 和 `eng-to-ipa`，并在安装阶段从 OpenJTalk 官方 GitHub release 下载日语离线词典；运行时不会联网补词典。随后在本机 `config.json` 中配置 RabiSpeech 自带 `local_onnx_vits_worker.py`。固定声线调用使用 `voice="speaker:<id>"`，不使用人格参考音频。

## 3. ASR 模型

| 别名 | 本机权重占用 | 适合用途 | 官方来源 |
|---|---:|---|---|
| `asr-whisper-tiny` | 约 0.08 GiB | 最低资源、接口冒烟与弱硬件 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| `asr-whisper-small` | 约 0.46 GiB | 日常多语言、速度与效果平衡 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| `asr-whisper-large-v3-turbo` | 约 1.51 GiB | 多语言通用基线 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| `asr-qwen3-0.6b` | 约 1.75 GiB | 多语言/方言，准确率与资源平衡 | [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) |
| `asr-qwen3-1.7b` | 约 4.38 GiB | 更大多语言/方言模型 | [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) |
| `asr-sensevoice-small` | 约 0.88 GiB | 中英粤日韩、情绪与音频事件 | [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) |
| `asr-fireredasr2-aed` | 约 4.41 GiB | 中文方言、英文、歌声与时间戳 | [FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S) |

### 3.1 faster-whisper tiny / small / large-v3-turbo

RabiSpeech 核心安装已包含 `faster-whisper==1.2.1`：

```powershell
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model asr-whisper-tiny
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model asr-whisper-small
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model asr-whisper-large-v3-turbo
& "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install.ps1"
```

Windows GPU 需要 CUDA 12 cuBLAS 和 cuDNN 9。RabiSpeech 把 NVIDIA 官方 Python wheel DLL 安装在私有 `.deps` 并只修改自己的 `PATH`，不从 DLL 下载站复制文件。

### 3.2 Qwen3-ASR 0.6B / 1.7B

```powershell
git clone https://github.com/QwenLM/Qwen3-ASR.git "$RUNTIME_ROOT\Qwen3-ASR"
py -3.10 -m venv "$RUNTIME_ROOT\Qwen3-ASR\.venv"
& "$RUNTIME_ROOT\Qwen3-ASR\.venv\Scripts\python.exe" -m pip install -e "$RUNTIME_ROOT\Qwen3-ASR"
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model asr-qwen3-0.6b
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model asr-qwen3-1.7b
```

模型 id 分别为 `qwen3-asr/qwen3-asr-0.6b` 和 `qwen3-asr/qwen3-asr-1.7b`。

### 3.3 SenseVoiceSmall

```powershell
git clone https://github.com/FunAudioLLM/SenseVoice.git "$RUNTIME_ROOT\SenseVoice"
py -3.10 -m venv "$RUNTIME_ROOT\SenseVoice\.venv"
& "$RUNTIME_ROOT\SenseVoice\.venv\Scripts\python.exe" -m pip install funasr soundfile
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model asr-sensevoice-small
```

模型 id：`sensevoice/sensevoice-small`。FunASR 启动时可能检查并调用 `pip`，因此 RabiSpeech 会把该 venv 的 `Scripts` 临时加入 worker `PATH`。

### 3.4 FireRedASR2-AED

```powershell
git clone https://github.com/FireRedTeam/FireRedASR2S.git "$RUNTIME_ROOT\FireRedASR2S"
py -3.10 -m venv "$RUNTIME_ROOT\FireRedASR2S\.venv"
py -3.10 "$RABI_ROUTE_ROOT\plugin-adapters\rabi-speech\scripts\install_models.py" --root $MODEL_ROOT --model asr-fireredasr2-aed
```

在 Windows/Python 3.10 上，本次可重现组合需要：`torch==2.1.0+cu118`、`torchaudio==2.1.0+cu118`、`setuptools<81`、`kaldi_native_fbank==1.22.3`。官方旧清单中的 1.15 已无法从当前 PyPI 安装，1.17 的 Windows wheel 在本机缺少可加载 DLL。worker 必须使用 FireRed 自己的 venv，并通过 `--repository-root` 加入源码根目录。

## 4. 安装后验证

启动 RabiSpeech 后：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8781/health'
$models = Invoke-RestMethod 'http://127.0.0.1:8781/v1/models'
$models.data | Select-Object id,capability,installed,languages,features
Invoke-RestMethod 'http://127.0.0.1:8781/v1/models/local-tts/gpt-sovits'
```

ASR 必须用真实音频做一次冷启动和一次热启动；TTS 必须生成可解码 WAV。仅目录存在、模块可 import 或 `/health` 返回 200 都不等于模型推理可用。

## 5. 常见问题

- Hugging Face 多 GiB 文件超时：把 `HF_HUB_DOWNLOAD_TIMEOUT` 调到 600 秒、`HF_HUB_ETAG_TIMEOUT` 调到 120 秒，降低 `--max-workers`；安装 `hf_xet` 后重试同一目录会续传。
- worker 导入了错误的 torch/tokenizers：每个模型用独立 venv；RabiSpeech 启动 worker 前清除继承的 `PYTHONPATH` / `PYTHONHOME`。
- `pkg_resources` 不存在：旧库使用 `setuptools<81`。
- NAS/映射盘出现 WinError 59：不要让 Lightning/pkg_resources 扫描 NAS 上的 RabiSpeech 源路径；模型仓库和 venv 放本机盘。
- GPT-SoVITS 缺语言检测或 NLTK：预先下载到本机，推理时启用 offline 环境变量。
- TorchCodec/FFmpeg 共享 DLL 失败：本地 WAV 使用 SoundFile fallback；不要把系统 FFmpeg DLL 随意复制进模型 venv。
- GPT-SoVITS prompt 超长：使用 3–10 秒干净连续片段和准确同语言转写。
- CUDA “可见”但推理才缺 DLL：`nvidia-smi` 的 CUDA 版本是驱动能力，不等于用户态 cuBLAS/cuDNN 已安装；必须用一次真实推理验收。
- 麦克风列表为空或启动失败：安装/重装 `sounddevice`，确认 Windows 隐私设置允许桌面应用访问麦克风，并在 RabiPC 的 ASR 标签重新扫描设备。当前录音由 RabiSpeech 服务进程持有，不依赖浏览器 `getUserMedia`，所以远程页面的 HTTPS 限制不影响主机常驻监听。
- 设备默认采样率与 16 kHz 不同：PortAudio/Windows 通常会转换；若返回 `Invalid sample rate`，先在 Windows 声音设置把设备设为 16/48 kHz，或在本机 `/v1/microphone/start` 请求显式传设备支持的 `sample_rate`。ASR 输入 WAV 会记录实际采样率。
- 虚拟麦克风回流：不要选带扬声器混音的设备。RabiSpeech 在本机 TTS 播放时暂停触发并清空当前片段，这只是第二层保护，不能替代正确设备选择。

更完整的本机结果见 [RabiSpeech 性能与功能报告](rabispeech-performance-report.md)。
