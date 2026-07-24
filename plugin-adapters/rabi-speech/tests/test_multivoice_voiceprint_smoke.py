from __future__ import annotations

import io
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf

from scripts.test_multivoice_voiceprint import (
    TARGET_SAMPLE_RATE,
    compose_sources,
    generate_tts_sources,
    parse_sources,
    resolve_model_id,
    summarize_diarization,
)


def test_composite_resamples_sources_and_preserves_explicit_voice_boundaries(tmp_path: Path) -> None:
    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    sf.write(first, np.full(8_000, 0.1, dtype=np.float32), 8_000)
    sf.write(second, np.full(16_000, -0.2, dtype=np.float32), 16_000)

    sources = parse_sources([f"alpha={first}", f"beta={second}"])
    output = tmp_path / "composite.wav"
    segments, evidence, rms, peak = compose_sources(sources, output, silence_ms=250)

    info = sf.info(str(output))
    assert info.samplerate == TARGET_SAMPLE_RATE
    assert info.channels == 1
    assert round(info.duration, 2) == 2.25
    assert [segment.speaker_label for segment in segments] == ["voice-1", "voice-2"]
    assert segments[0].end == 1.0
    assert segments[1].start == 1.25
    assert len(evidence) == 2
    assert all(len(str(item["sha256"])) == 64 for item in evidence)
    assert 0 < rms < peak <= 1


def test_generated_tts_sources_use_rabispeech_and_anonymous_filenames(tmp_path: Path) -> None:
    buffer = io.BytesIO()
    sf.write(buffer, np.full(TARGET_SAMPLE_RATE, 0.1, dtype=np.float32), TARGET_SAMPLE_RATE, format="WAV")
    wav = buffer.getvalue()
    requested_voices: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_voices.append(str(request.read()))
        return httpx.Response(200, content=wav, headers={"content-type": "audio/wav"})

    sources = generate_tts_sources(
        ["private-voice-a", "private-voice-b"],
        model="configured/tts-model",
        text="private smoke text",
        service_url="http://127.0.0.1:8781",
        output_dir=tmp_path,
        timeout_seconds=10,
        transport=httpx.MockTransport(handler),
    )

    assert [label for label, _ in sources] == ["voice-1", "voice-2"]
    assert [path.name for _, path in sources] == ["source-1.wav", "source-2.wav"]
    assert len(requested_voices) == 2


def test_model_discovery_resolves_a_unique_short_name_to_the_current_full_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json=[
            {
                "id": "configured-provider/current-tts",
                "model": "current-tts",
                "capability": "tts",
                "enabled": True,
                "available": True,
            },
            {
                "id": "configured-provider/current-asr",
                "model": "current-asr",
                "capability": "asr",
                "enabled": True,
                "available": True,
            },
        ])

    resolved = resolve_model_id(
        "current-tts",
        capability="tts",
        service_url="http://127.0.0.1:8781",
        timeout_seconds=10,
        transport=httpx.MockTransport(handler),
    )

    assert resolved == "configured-provider/current-tts"


def test_model_discovery_rejects_an_ambiguous_short_name() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[
            {"id": "provider-a/shared", "model": "shared", "capability": "tts"},
            {"id": "provider-b/shared", "model": "shared", "capability": "tts"},
        ])

    try:
        resolve_model_id(
            "shared",
            capability="tts",
            service_url="http://127.0.0.1:8781",
            timeout_seconds=10,
            transport=httpx.MockTransport(handler),
        )
    except ValueError as error:
        assert "ambiguous" in str(error)
        assert "provider-a/shared" in str(error)
        assert "provider-b/shared" in str(error)
    else:
        raise AssertionError("Ambiguous model aliases must require a full id.")


def test_diarization_summary_fails_when_provider_merge_also_collapses_voiceprints() -> None:
    report = summarize_diarization(
        {
            "provider": "configured-asr",
            "model": "meeting-model",
            "duration": 18.2,
            "segments": [
                {"start": 0, "end": 6.0, "speaker": "speaker-a", "voiceprint_id": "cluster-a"},
                {"start": 6.1, "end": 12.0, "speaker": "speaker-b", "voiceprint_id": "cluster-b"},
                {"start": 12.1, "end": 18.2, "speaker": "speaker-a", "voiceprint_id": "cluster-a"},
            ],
        },
        expected_voices=3,
    )

    assert report["segmentCount"] == 3
    assert report["anonymousSpeakerCount"] == 2
    assert report["distinctVoiceprints"] == 2
    assert report["providerSpeakerCountMatched"] is False
    assert report["voiceprintCountMatched"] is False
    assert report["providerMergeCorrectedByVoiceprint"] is False
    assert report["passed"] is False
    assert report["decisions"][0]["speakerOrdinal"] == report["decisions"][2]["speakerOrdinal"]


def test_diarization_summary_accepts_voiceprint_correction_of_provider_merge() -> None:
    report = summarize_diarization(
        {
            "provider": "configured-asr",
            "model": "meeting-model",
            "duration": 18.2,
            "segments": [
                {"start": 0, "end": 6.0, "speaker": "speaker-a", "voiceprint_id": "cluster-a"},
                {"start": 6.1, "end": 12.0, "speaker": "speaker-b", "voiceprint_id": "cluster-b"},
                {"start": 12.1, "end": 18.2, "speaker": "speaker-a", "voiceprint_id": "cluster-c"},
            ],
        },
        expected_voices=3,
    )

    assert report["anonymousSpeakerCount"] == 2
    assert report["distinctVoiceprints"] == 3
    assert report["providerSpeakerCountMatched"] is False
    assert report["voiceprintCountMatched"] is True
    assert report["providerMergeCorrectedByVoiceprint"] is True
    assert report["passed"] is True
