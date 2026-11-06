from __future__ import annotations

import asyncio
import base64
import json
import wave
from pathlib import Path

import httpx
import pytest

from rabispeech.config import ApiModelSettings, ApiProviderSettings
from rabispeech.contracts import SpeechSynthesisRequest, TranscriptionRequest
from rabispeech.providers import DashScopeAsrProvider, DashScopeTtsProvider
from rabispeech.providers.dashscope import _extract_text, _wav_duration


def settings(kind: str) -> ApiProviderSettings:
    model = "qwen3-tts-instruct-flash" if kind == "tts" else "qwen3-asr-flash"
    return ApiProviderSettings(
        id="dashscope-qwen",
        enabled=True,
        protocol="dashscope",
        base_url="https://dashscope.aliyuncs.com",
        api_key_env="DASHSCOPE_API_KEY",
        default_model=model,
        default_voice="Cherry",
        timeout_seconds=10,
        models=(ApiModelSettings(id=model, name=model, languages=("multilingual",), features=()),),
    )


def wav_file(path: Path) -> Path:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 160)
    return path


def test_dashscope_text_extraction_ignores_non_transcript_string_metadata() -> None:
    payload = {
        "file_url": "https://example.invalid/private.wav",
        "format": "pcm_s16le",
        "transcripts": [{"text": "会议内容", "words": [{"text": "会议"}, {"text": "内容"}]}],
    }
    text = _extract_text(payload)
    assert "example.invalid" not in text
    assert "pcm_s16le" not in text
    assert "会议内容" in text


def test_wav_duration_caps_streaming_placeholder_header(tmp_path: Path) -> None:
    audio = wav_file(tmp_path / "streaming.wav")
    raw = bytearray(audio.read_bytes())
    raw[40:44] = (0x7FFFFFFF).to_bytes(4, "little")
    audio.write_bytes(raw)
    assert _wav_duration(audio) < 1


def test_dashscope_asr_uses_fennenote_multimodal_contract(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-secret")
    audio = wav_file(tmp_path / "sample.wav")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        assert request.headers["authorization"] == "Bearer test-secret"
        payload = json.loads(request.content)
        assert payload["model"] == "qwen3-asr-flash"
        assert payload["input"]["messages"][1]["content"][0]["audio"].startswith("data:audio/wav;base64,")
        assert payload["parameters"]["asr_options"]["language"] == "zh"
        return httpx.Response(200, json={"output": {"choices": [{"message": {"content": [{"text": "你好，世界。"}]}}]}})

    provider = DashScopeAsrProvider(settings("asr"), httpx.MockTransport(handler))
    result = asyncio.run(provider.transcribe(TranscriptionRequest(audio_path=audio, model="qwen3-asr-flash", language="zh")))
    assert result.text == "你好，世界。"
    assert result.provider == "dashscope-qwen"
    assert result.duration == 0.01


def test_dashscope_tts_uses_qwen_native_contract_and_base64_audio(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-secret")
    encoded = base64.b64encode(b"RIFF-qwen-audio").decode("ascii")

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload == {
            "model": "qwen3-tts-instruct-flash",
            "input": {
                "text": "你好",
                "voice": "Cherry",
                "language_type": "Chinese",
                "stream": False,
                "instructions": "温柔地说",
                "optimize_instructions": True,
            },
        }
        return httpx.Response(200, json={"output": {"audio": {"data": encoded, "response_format": "wav"}}})

    provider = DashScopeTtsProvider(settings("tts"), tmp_path, httpx.MockTransport(handler))
    artifact = asyncio.run(
        provider.synthesize(
            SpeechSynthesisRequest(
                text="你好",
                model="qwen3-tts-instruct-flash",
                voice="Cherry",
                language="Chinese",
                instructions="温柔地说",
            )
        )
    )
    assert artifact.path.read_bytes() == b"RIFF-qwen-audio"
    assert artifact.cleanup is True


def test_dashscope_provider_errors_do_not_echo_secret_body(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-secret")
    private_value = "private-voice-id"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "InvalidParameter", "message": private_value})

    provider = DashScopeTtsProvider(settings("tts"), tmp_path, httpx.MockTransport(handler))
    try:
        asyncio.run(provider.synthesize(SpeechSynthesisRequest(text="你好", model="qwen3-tts-instruct-flash", voice="Cherry")))
    except RuntimeError as exc:
        assert "HTTP 400" in str(exc)
        assert private_value not in str(exc)
    else:
        raise AssertionError("Expected DashScope HTTP failure")


def test_dashscope_meeting_asr_returns_speaker_turns(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-secret")
    audio = wav_file(tmp_path / "meeting.wav")
    base = settings("asr")
    meeting_settings = ApiProviderSettings(
        **{
            **base.__dict__,
            "models": (
                ApiModelSettings(
                    id="paraformer-v2",
                    name="Meeting ASR",
                    languages=("zh",),
                    features=("speaker_diarization", "meeting"),
                ),
            ),
            "default_model": "paraformer-v2",
        }
    )
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if request.url.path.endswith("/transcription"):
            payload = json.loads(request.content)
            assert payload["input"]["file_urls"] == ["oss://temporary/meeting.wav"]
            assert payload["parameters"] == {
                "diarization_enabled": True,
                "language_hints": ["zh"],
                "speaker_count": 2,
            }
            return httpx.Response(200, json={"output": {"task_id": "task-1", "task_status": "PENDING"}})
        if request.url.path.endswith("/tasks/task-1"):
            return httpx.Response(
                200,
                json={
                    "output": {
                        "task_status": "SUCCEEDED",
                        "results": [
                            {
                                "sentences": [
                                    {"begin_time": 0, "end_time": 1200, "speaker_id": 0, "text": "大家好。"},
                                    {"begin_time": 1300, "end_time": 2500, "speaker_id": "1", "text": "开始开会。"},
                                ]
                            }
                        ],
                    }
                },
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    provider = DashScopeAsrProvider(
        meeting_settings,
        httpx.MockTransport(handler),
        uploader=lambda _model, _path, _key: "oss://temporary/meeting.wav",
    )
    result = asyncio.run(
        provider.transcribe(
            TranscriptionRequest(audio_path=audio, model="paraformer-v2", language="zh", speaker_count=2)
        )
    )
    assert calls == 2
    assert result.text == "[0] 大家好。\n[1] 开始开会。"
    assert [(item.speaker, item.start, item.end) for item in result.segments] == [("0", 0.0, 1.2), ("1", 1.3, 2.5)]


def test_dashscope_meeting_asr_treats_no_valid_fragment_as_empty_audio(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-secret")
    audio = wav_file(tmp_path / "noise.wav")
    base = settings("asr")
    meeting_settings = ApiProviderSettings(
        **{
            **base.__dict__,
            "models": (
                ApiModelSettings(
                    id="paraformer-v2",
                    name="Meeting ASR",
                    languages=("zh",),
                    features=("speaker_diarization", "meeting"),
                ),
            ),
            "default_model": "paraformer-v2",
        }
    )
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if request.url.path.endswith("/transcription"):
            payload = json.loads(request.content)
            assert payload["parameters"]["language_hints"] == ["zh"]
            return httpx.Response(200, json={"output": {"task_id": "task-empty", "task_status": "PENDING"}})
        if request.url.path.endswith("/tasks/task-empty"):
            return httpx.Response(
                200,
                json={
                    "output": {
                        "task_status": "FAILED",
                        "results": [{
                            "subtask_status": "FAILED",
                            "code": "SUCCESS_WITH_NO_VALID_FRAGMENT",
                            "message": "SUCCESS_WITH_NO_VALID_FRAGMENT",
                        }],
                    }
                },
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    provider = DashScopeAsrProvider(meeting_settings, httpx.MockTransport(handler))
    result = asyncio.run(
        provider.transcribe(TranscriptionRequest(audio_path=audio, model="paraformer-v2", language="zh"))
    )

    assert calls == 2
    assert result.text == ""
    assert result.segments == []
    assert result.duration == 0.01
    assert result.provider == "dashscope-qwen"


def test_dashscope_meeting_asr_preserves_other_subtask_failure_codes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-secret")
    audio = wav_file(tmp_path / "broken.wav")
    base = settings("asr")
    meeting_settings = ApiProviderSettings(
        **{
            **base.__dict__,
            "models": (
                ApiModelSettings(
                    id="paraformer-v2",
                    name="Meeting ASR",
                    languages=("zh",),
                    features=("speaker_diarization", "meeting"),
                ),
            ),
            "default_model": "paraformer-v2",
        }
    )
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if request.url.path.endswith("/transcription"):
            return httpx.Response(200, json={"output": {"task_id": "task-failed", "task_status": "PENDING"}})
        if request.url.path.endswith("/tasks/task-failed"):
            return httpx.Response(
                200,
                json={
                    "output": {
                        "task_status": "FAILED",
                        "results": [{
                            "subtask_status": "FAILED",
                            "code": "InvalidFile.DownloadFailed",
                            "message": "private provider detail",
                        }],
                    }
                },
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    provider = DashScopeAsrProvider(meeting_settings, httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match="code=InvalidFile.DownloadFailed") as raised:
        asyncio.run(provider.transcribe(TranscriptionRequest(audio_path=audio, model="paraformer-v2", language="zh")))

    assert calls == 2
    assert "private provider detail" not in str(raised.value)


def test_dashscope_persona_voice_reads_private_voice_from_named_environment(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-secret")
    monkeypatch.setenv("RABISPEECH_TEST_VOICE_ID", "private-provider-voice")
    roles = tmp_path / "roles"
    voice_dir = roles / "ExampleRole" / "voice"
    voice_dir.mkdir(parents=True)
    (voice_dir / "voice-profile.json").write_text(
        json.dumps(
            {
                "engine_options": {
                    "dashscope-qwen": {
                        "model": "qwen3-tts-instruct-flash",
                        "voice_env": "RABISPEECH_TEST_VOICE_ID",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    encoded = base64.b64encode(b"RIFF-persona-audio").decode("ascii")

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["input"]["voice"] == "private-provider-voice"
        assert "private-provider-voice" not in json.dumps(DashScopeTtsProvider(settings("tts"), tmp_path).capabilities())
        return httpx.Response(200, json={"output": {"audio": {"data": encoded, "response_format": "wav"}}})

    provider = DashScopeTtsProvider(settings("tts"), tmp_path, httpx.MockTransport(handler), roles_root=roles)
    artifact = asyncio.run(
        provider.synthesize(
            SpeechSynthesisRequest(text="你好", model="qwen3-tts-instruct-flash", voice="examplerole")
        )
    )
    assert artifact.path.read_bytes() == b"RIFF-persona-audio"
