<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Rabi 语音客户端

Rabi 语音客户端把会议室电脑变成 RabiSpeech 的局域网远程麦克风和喇叭。客户端只持续上传单声道 PCM，并播放主机下发的 WAV；VAD、静音切句、ASR、Route 广播、人格 TTS、FIFO 和防回流仍全部由 RabiSpeech 主机控制。远程声卡入口由主机强制归类为 `messageAdapterType=speech`，客户端握手不能改成 `rabilink`，因此它不会被误当成手机/RabiLink 消息。

当前只支持可信局域网直连。RabiLink 保持独立，不是客户端的配置前置条件；跨公网音频流中转尚未接入。

## 主机配置

在运行 RabiSpeech 的公司电脑上，先更新语音插件依赖，再编辑 Git 忽略的 `plugin-adapters/rabi-speech/config.json`：

```powershell
.\plugin-adapters\rabi-speech\scripts\install.ps1
```

```json
{
  "remote_audio": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8782,
    "discovery_port": 8783,
    "token_env": "RABISPEECH_AUDIO_STREAM_TOKEN",
    "token_path": "output/audio-stream-token.txt",
    "settings_path": "output/audio-stream-settings.json"
  }
}
```

重启 RabiSpeech。未设置 `RABISPEECH_AUDIO_STREAM_TOKEN` 时，服务会在私有运行目录自动生成 `output/audio-stream-token.txt`。也可以在 RibiWebGUI“语音服务 → 音频流”显式点击“复制客户端连接密钥”。不要把该密钥提交、截图或发到公共聊天。

Windows 防火墙只需在“专用网络”允许：

- TCP `8782`：鉴权后的音频 WebSocket；
- UDP `8783`：只返回主机名和端口的局域网发现，不返回密钥。

不要把这两个端口映射到公网。

## 会议室电脑

从发布包解压并运行 `RabiVoiceClient.exe`。客户端现在默认打开与 RabiRoute 本体统一视觉语言的桌面控制台，不需要先手工创建配置文件：

- 在“主机地址”保留 `auto`，或填写 `ws://<公司电脑局域网 IP>:8782`；
- 粘贴 RibiWebGUI“语音服务 → 音频流”显示的客户端连接密钥；
- 选择会议室电脑真实使用的麦克风和扬声器；
- 点击“连接主机”。

界面会持续显示连接、主机采集请求、播放状态、当前端点和实时麦克风电平。设置保存在 EXE 同目录的私有 `config.json`。已有部署仍可直接使用下面的配置格式：

```json
{
  "server_url": "auto",
  "token": "粘贴公司电脑 output/audio-stream-token.txt 的内容",
  "client_id": "meeting-room-a",
  "name": "会议室 A",
  "input_device": null,
  "output_device": null,
  "sample_rate": 16000,
  "chunk_ms": 100,
  "reconnect_seconds": 3
}
```

`server_url=auto` 会用 UDP 自动发现同网段主机；如果广播被 VLAN 或防火墙拦截，可改成 `ws://<公司电脑局域网 IP>:8782`。

界面无法列出设备或需要脚本化排障时运行：

```powershell
RabiVoiceClient.exe --list-devices
```

GUI 发布包会把结果写到同目录的 `audio-devices.txt`；源码控制台运行时会直接打印。然后把输入/输出设备编号写入 `config.json`。回到 RibiWebGUI“语音服务”，在顶部“音频流类型”选择已上线的会议室客户端。

无人值守环境可继续使用：

```powershell
RabiVoiceClient.exe --headless
```

远端客户端断线时不会静默回退到公司电脑麦克风；页面会保留远端选择并显示离线，避免采集位置悄悄改变。

## 构建独立 EXE

```powershell
.\desktop\rabi-voice-client\scripts\build-windows.ps1
```

脚本使用 PyInstaller 生成无需 Python 的 GUI `RabiVoiceClient.exe` 和可复制的 `RabiVoiceClient-windows-x64.zip`。发布包使用 RabiRoute 图标，GUI 模式不显示额外控制台窗口。
