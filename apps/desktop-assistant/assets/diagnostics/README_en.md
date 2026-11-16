[中文](README.md)

# Recognition diagnostic resources

`recognition-zh-CN.wav` is the public fixed input for the shipped Recognition sample check. It says “今天天气怎么样？” (What is the weather like today?). It is not an application user's recording or a persona voice reference. Runtime diagnostics and development tests share this file; development-only mock inputs remain in `test/fixtures`.

The source is Microsoft's official [Speech SDK samples repository](https://github.com/Azure-Samples/cognitive-services-speech-sdk). [source.json](source.json) records the immutable commit, original path, Git blob, SHA256, format and transcript. The upstream bytes are unchanged; the WAV contains only PCM format and audio data chunks, without user paths, credentials or application runtime metadata. The repository's MIT license permits copying and distribution with its copyright and license notice, reproduced in [LICENSE.Microsoft.txt](LICENSE.Microsoft.txt). Its third-party notices and sample directories contain no separate license declaration for this audio.

Runtime reads the packaged file without PowerShell, installed system voices, the Azure SDK or a download. The selected ASR must support Mandarin. This checks connectivity and transcription, not recognition accuracy. A missing or corrupt resource fails explicitly and never fabricates a transcript.
