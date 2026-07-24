<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Voice Client

Rabi Voice Client turns a meeting-room PC into a LAN microphone and speaker for RabiSpeech. The client only uploads mono PCM continuously and plays WAV audio sent by the host. VAD, silence segmentation, ASR, Route broadcast, persona TTS, FIFO playback, and feedback suppression remain owned by the RabiSpeech host. The host forces this network sound-card entry point to `messageAdapterType=speech`; a client hello cannot switch it to `rabilink`, so it cannot be mistaken for phone/RabiLink input.

The current release supports trusted-LAN direct connections only. RabiLink remains independent and is not required configuration; public-network audio-stream relay is not connected yet.

## Host setup

On the PC running RabiSpeech, update the speech-plugin dependencies first, then edit the Git-ignored `plugin-adapters/rabi-speech/config.json`:

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

Restart RabiSpeech. If `RABISPEECH_AUDIO_STREAM_TOKEN` is unset, the service generates a private `output/audio-stream-token.txt`. You can also explicitly click **Copy client connection token** under **Speech Service → Audio stream** in RibiWebGUI. Do not commit, screenshot, or post this token publicly.

Allow only on the Windows Private network:

- TCP `8782` for the authenticated audio WebSocket;
- UDP `8783` for LAN discovery, which exposes only the host name and port, never the token.

Do not forward these ports to the public Internet.

## Meeting-room PC

Extract and run `RabiVoiceClient.exe`. The client now opens a desktop control console that shares RabiRoute's visual language, so a configuration file no longer needs to be created by hand first:

- keep `auto` as the server address, or enter `ws://<office-PC-LAN-IP>:8782`;
- paste the client connection key shown under **Speech Service → Audio stream** in RibiWebGUI;
- select the microphone and speaker actually used by the room PC;
- select **Connect host**.

The window continuously shows connection state, host capture requests, playback state, the resolved endpoint, and live microphone level. Settings are stored in the private `config.json` beside the executable. Existing deployments can still use the following format directly:

```json
{
  "server_url": "auto",
  "token": "paste the host output/audio-stream-token.txt value",
  "client_id": "meeting-room-a",
  "name": "Meeting Room A",
  "input_device": null,
  "output_device": null,
  "sample_rate": 16000,
  "chunk_ms": 100,
  "reconnect_seconds": 3
}
```

`server_url=auto` discovers a host on the same LAN. If VLAN or firewall policy blocks broadcast discovery, use `ws://<host-LAN-IP>:8782`.

If the GUI cannot enumerate devices or scripted troubleshooting is required:

```powershell
RabiVoiceClient.exe --list-devices
```

The GUI package writes the result to `audio-devices.txt` beside the executable; source console runs print it directly. Put the chosen input/output indices in `config.json`, then select the online client from the **Audio stream type** control at the top of RibiWebGUI's Speech Service page.

Unattended deployments can continue to use:

```powershell
RabiVoiceClient.exe --headless
```

If the remote client disconnects, RabiSpeech does not silently fall back to the host microphone. The selection stays remote and is shown offline so the capture location cannot change unnoticed.

## Build the standalone EXE

```powershell
.\desktop\rabi-voice-client\scripts\build-windows.ps1
```

The script uses PyInstaller to produce a standalone GUI `RabiVoiceClient.exe` and `RabiVoiceClient-windows-x64.zip`. The package uses the RabiRoute icon and does not open an extra console window in GUI mode.
