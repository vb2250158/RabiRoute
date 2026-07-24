<!-- docs-language-switch -->
<div align="center">
English | <a href="./speech-api.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Call TTS and ASR remotely

Use this guide to call RabiSpeech on a selected Rabi PC from another computer, a phone backend, or an automation client through RabiLink Relay. Ordinary TTS and file-ASR requests return audio or a transcription directly and do not enter an Agent, persona, Route, or conversation ledger. Continuous Android/glasses PCM streaming is the explicit exception: after PC ASR, it automatically enters the host-wide speech store and `rabilink` Route.

> Maturity: experimental. Validate models, timeouts, and the public reverse proxy in a controlled environment before integrating a production client.

## Choose the correct entry point

| Caller location | Base URL | Authentication | Use case |
| --- | --- | --- | --- |
| On the Rabi PC | `http://127.0.0.1:8781` | No public token | Local scripts and plugin troubleshooting |
| Any remote client | `https://<RELAY_ORIGIN>/api/rabilink/speech` | RabiLink **application token** | Phone backends, other computers, controlled services |

Do not copy the loopback address to another device. Do not use a glasses device token for this API; speech calls require an application token.

## Prepare the remote path

1. Connect the target Rabi PC to Relay from **Rabi instances**.
2. Enable **Allow speech relay** and keep the local speech target at `http://127.0.0.1:8781`.
3. In the application's Relay `/manage` page, select that online Rabi PC.
4. Copy the application's token. Keep it in a temporary process variable or secret store, not in the repository, logs, or URL.

The commands below use Windows PowerShell and the system `curl.exe`. Define two values first:

```powershell
$RelayOrigin = "https://relay.example.com"
$Token = "<RABILINK_APP_TOKEN>"
$SpeechBase = "$RelayOrigin/api/rabilink/speech"
```

Replace `https://relay.example.com` with the Relay HTTPS origin and `<RABILINK_APP_TOKEN>` with the application token.

## 1. Verify the PC and model inventory

```powershell
curl.exe --fail-with-body --silent --show-error `
  "$SpeechBase/health" `
  -H "Authorization: Bearer $Token"

curl.exe --fail-with-body --silent --show-error `
  "$SpeechBase/v1/models" `
  -H "Authorization: Bearer $Token"
```

Both commands return JSON on success. The model inventory comes from the selected PC, not the Relay server.

## 2. Generate TTS audio

```powershell
curl.exe --fail-with-body --silent --show-error `
  -X POST "$SpeechBase/v1/audio/speech" `
  -H "Authorization: Bearer $Token" `
  -H "Content-Type: application/json" `
  --data-raw '{"input":"Hello from the RabiSpeech API through RabiLink.","voice":"default","response_format":"wav","sample_rate":16000,"speed":1.0}' `
  --output speech.wav

Get-Item .\speech.wav | Select-Object Name, Length
```

Success means the HTTP request completed and `speech.wav` has a `Length` greater than zero. The target PC's RabiSpeech applies WAV `sample_rate` locally, so the remote caller does not need ffmpeg; MP3, FLAC, Opus, AAC, and raw-PCM output still depends on the target PC's ffmpeg configuration. To select a model, copy an actual model ID from `/v1/models` and add `model` to the JSON body.

## 3. Transcribe the generated audio

Use the file created above:

```powershell
curl.exe --fail-with-body --silent --show-error `
  -X POST "$SpeechBase/v1/audio/transcriptions" `
  -H "Authorization: Bearer $Token" `
  -F "file=@speech.wav" `
  -F "language=en" `
  -F "response_format=verbose_json"
```

A successful call returns JSON containing the transcription. `file` is required. To select an ASR model, first obtain its current ID from `/v1/models`.

Clear the token from the current PowerShell session when finished:

```powershell
$Token = $null
```

## Common errors

| Status | Meaning | Recovery |
| --- | --- | --- |
| `401` | The application token is missing, invalid, or was reset | Copy it again from the target application and inspect the request header |
| `403` | A device token or another unsupported credential was used | Use the application token |
| `404` | The path is not in the Relay speech allowlist | Verify the complete `/api/rabilink/speech/...` path |
| `409` | No usable PC is selected, or speech relay is disabled on the target | Select the PC in `/manage`; verify that it is online and enabled |
| `413` | The upload exceeds the current limit, 25 MiB by default | Shorten or compress the audio |
| `502` | The PC or local RabiSpeech failed while processing | Inspect Speech service status and logs on the target PC |
| `504` | Model startup or processing exceeded the Relay wait | Run health/warmup first, or adjust the controlled deployment timeout |

The public allowlist excludes microphone start/stop, persona directories, model downloads, and Python extension loading. A remote caller may only use allowed endpoints and models already installed on the target PC.

## Switch to a local call

On the target PC, set `$SpeechBase` to `http://127.0.0.1:8781` and remove the `Authorization` header. The other OpenAI-compatible request fields stay the same.

## Open the target-machine report

Open **Speech service** in the local or remote RibiWebGUI, then select **Target-machine report**. On a remote page, the report stays under the current `/manage/<account>/<RabiGUID>/` prefix. It describes only the named test machine, not the current client's live performance.

## API reference

- `GET /api/rabilink/speech/health`
- `GET /api/rabilink/speech/v1/models`
- `GET /api/rabilink/speech/v1/capabilities`
- `POST /api/rabilink/speech/v1/audio/speech`
- `POST /api/rabilink/speech/v1/audio/transcriptions`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/start`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1`
- `POST /api/rabilink/speech/v1/audio-streams/rabilink/stop`
- `GET /api/rabilink/speech/openapi.json`

The three streaming endpoints are for continuous Android/glasses 16 kHz mono PCM. `sequence` starts at 1 and must remain contiguous. Target-PC RabiSpeech owns VAD, segmentation, ASR, and voiceprint processing, and retires a stream after 15 seconds without PCM. Manual TTS/file-ASR callers keep using the synchronous endpoints above. See [RabiSpeech local TTS / ASR service](../rabispeech-plugin_en.md) for fields, compatibility endpoints, and local extension boundaries.
