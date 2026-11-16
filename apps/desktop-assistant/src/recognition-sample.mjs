import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$audio = New-Object System.IO.MemoryStream
try {
  $voices = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled })
  $voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  $text = '你好，这是语音识别测试。'
  if (-not $voice) {
    $voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
    $text = 'Hello. This is a speech recognition test.'
  }
  if (-not $voice) { throw 'ASR_SAMPLE_SOURCE_UNAVAILABLE' }
  $speaker.SelectVoice($voice.VoiceInfo.Name)
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $speaker.SetOutputToAudioStream($audio, $format)
  $speaker.Speak($text)
  $speaker.SetOutputToNull()
  [Console]::Out.Write([Convert]::ToBase64String($audio.ToArray()))
} finally {
  $speaker.Dispose()
  $audio.Dispose()
}
`;

/** Fixed public test text, synthesized in memory by the OS. No recordings or persona voices. */
export async function createSystemRecognitionSample({ platform = process.platform, run = execute } = {}) {
  if (platform !== 'win32') throw Error('ASR_SAMPLE_SOURCE_UNAVAILABLE');
  let pcm;
  try {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await run(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', shell: false,
    });
    const encoded = stdout.trim();
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error('ASR_SAMPLE_SOURCE_UNAVAILABLE');
    pcm = Buffer.from(encoded, 'base64');
    if (!pcm.length || pcm.length % 2 || pcm.length > 1024 * 1024) throw Error('ASR_SAMPLE_SOURCE_UNAVAILABLE');
  } catch {
    throw Error('ASR_SAMPLE_SOURCE_UNAVAILABLE');
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}
