from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse


SERVICE_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_DEPS = SERVICE_ROOT / ".deps"
for candidate in (PRIVATE_DEPS, SERVICE_ROOT):
    value = str(candidate)
    if candidate.is_dir() and value not in sys.path:
        sys.path.insert(0, value)

import numpy as np
import soundfile as sf
import httpx

from rabispeech.config import load_settings
from rabispeech.contracts import TranscriptSegment, TranscriptionResult


TARGET_SAMPLE_RATE = 16_000
DEFAULT_TTS_TEXT = "今天我们用同一句完整语音测试不同说话人的声纹是否能够稳定区分。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compose multiple TTS WAVs into one synthetic recording and run the real local voiceprint "
            "extractor against explicit composition boundaries. This is never formal real-person validation."
        )
    )
    parser.add_argument(
        "--source",
        action="append",
        metavar="LABEL=PATH",
        help="Synthetic voice label and existing TTS WAV. Repeat for at least two distinct labels.",
    )
    parser.add_argument(
        "--tts-voice",
        action="append",
        help="Voice selector sent to the running RabiSpeech TTS API. Repeat for at least two voices.",
    )
    parser.add_argument("--tts-model", help="RabiSpeech TTS model id used with --tts-voice.")
    parser.add_argument("--tts-text", default=DEFAULT_TTS_TEXT, help="Private synthesis text; never written to the report.")
    parser.add_argument("--service-url", default="http://127.0.0.1:8781")
    parser.add_argument("--asr-model", help="Optional RabiSpeech ASR model id used for real diarization validation.")
    parser.add_argument("--asr-language", default="zh")
    parser.add_argument("--speaker-count", type=int, help="Expected ASR speaker count; defaults to the source count.")
    parser.add_argument("--request-timeout-seconds", type=float, default=300.0)
    parser.add_argument("--config", default=str(SERVICE_ROOT / "config.json"))
    parser.add_argument("--output", help="Ignored output directory. Defaults under output/acceptance/.")
    parser.add_argument("--silence-ms", type=int, default=350)
    return parser.parse_args()


def _loopback_base_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("--service-url must be an HTTP loopback URL.")
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", "", ""))


def resolve_model_id(
    requested: str,
    *,
    capability: str,
    service_url: str,
    timeout_seconds: float,
    transport: httpx.BaseTransport | None = None,
) -> str:
    model = requested.strip()
    if not model:
        raise ValueError(f"A {capability.upper()} model is required.")
    if timeout_seconds <= 0:
        raise ValueError("--request-timeout-seconds must be positive.")
    base_url = _loopback_base_url(service_url)
    timeout = httpx.Timeout(timeout_seconds, connect=min(15.0, timeout_seconds))
    with httpx.Client(timeout=timeout, transport=transport) as client:
        response = client.get(f"{base_url}/v1/models")
    if response.status_code != 200:
        raise RuntimeError(f"RabiSpeech model discovery failed with HTTP {response.status_code}.")
    payload = response.json()
    if isinstance(payload, list):
        models = payload
    elif isinstance(payload, dict):
        raw_models = payload.get("data", payload.get("models", []))
        models = raw_models if isinstance(raw_models, list) else []
    else:
        models = []
    candidates = [
        item for item in models
        if isinstance(item, dict)
        and str(item.get("capability") or "").strip().lower() == capability.lower()
        and item.get("available") is not False
        and item.get("enabled") is not False
    ]
    exact = [item for item in candidates if str(item.get("id") or "").strip() == model]
    if len(exact) == 1:
        return str(exact[0]["id"])
    aliases = [
        item for item in candidates
        if str(item.get("model") or "").strip() == model
        or str(item.get("id") or "").strip().rsplit("/", 1)[-1] == model
    ]
    unique_ids = sorted({str(item.get("id") or "").strip() for item in aliases if str(item.get("id") or "").strip()})
    if len(unique_ids) == 1:
        return unique_ids[0]
    if len(unique_ids) > 1:
        raise ValueError(
            f"RabiSpeech {capability.upper()} model '{model}' is ambiguous; use one full id from /v1/models: "
            + ", ".join(unique_ids)
        )
    raise ValueError(f"RabiSpeech has no available {capability.upper()} model matching '{model}'. Query /v1/models first.")


def generate_tts_sources(
    voices: list[str],
    *,
    model: str,
    text: str,
    service_url: str,
    output_dir: Path,
    timeout_seconds: float,
    transport: httpx.BaseTransport | None = None,
) -> list[tuple[str, Path]]:
    normalized_voices = [voice.strip() for voice in voices if voice.strip()]
    if len(normalized_voices) < 2:
        raise ValueError("At least two --tts-voice values are required.")
    if not model.strip():
        raise ValueError("--tts-model is required with --tts-voice.")
    if not text.strip():
        raise ValueError("--tts-text must not be empty.")
    if timeout_seconds <= 0:
        raise ValueError("--request-timeout-seconds must be positive.")
    base_url = _loopback_base_url(service_url)
    output_dir.mkdir(parents=True, exist_ok=True)
    sources: list[tuple[str, Path]] = []
    timeout = httpx.Timeout(timeout_seconds, connect=min(15.0, timeout_seconds))
    with httpx.Client(timeout=timeout, transport=transport) as client:
        for index, voice in enumerate(normalized_voices, start=1):
            response = client.post(
                f"{base_url}/v1/audio/speech",
                json={
                    "model": model.strip(),
                    "input": text.strip(),
                    "voice": voice,
                    "response_format": "wav",
                    "sample_rate": TARGET_SAMPLE_RATE,
                    "speed": 1.0,
                    "play": False,
                    "session_id": f"synthetic-multivoice-tts-{index}",
                },
            )
            if response.status_code != 200:
                raise RuntimeError(f"RabiSpeech TTS source {index} failed with HTTP {response.status_code}.")
            target = output_dir / f"source-{index}.wav"
            target.write_bytes(response.content)
            _mono_16k(target)
            sources.append((f"voice-{index}", target))
    return sources


def parse_sources(values: list[str]) -> list[tuple[str, Path]]:
    sources: list[tuple[str, Path]] = []
    for raw in values:
        label, separator, raw_path = raw.partition("=")
        label = label.strip()
        path = Path(raw_path.strip()).expanduser().resolve() if separator else Path()
        if not label or not separator or not path.is_file():
            raise ValueError("Each --source must use LABEL=PATH and point to an existing WAV file.")
        sources.append((label, path))
    if len(sources) < 2 or len({label.casefold() for label, _ in sources}) < 2:
        raise ValueError("At least two sources with distinct labels are required.")
    return sources


def _mono_16k(path: Path) -> np.ndarray:
    audio, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    if sample_rate <= 0 or audio.shape[0] == 0:
        raise ValueError("A source WAV has no usable audio frames.")
    mono = np.ascontiguousarray(audio.mean(axis=1), dtype=np.float32)
    if sample_rate != TARGET_SAMPLE_RATE:
        target_frames = max(1, int(round(mono.size * TARGET_SAMPLE_RATE / sample_rate)))
        source_positions = np.arange(mono.size, dtype=np.float64)
        target_positions = np.linspace(0.0, max(0.0, mono.size - 1.0), target_frames, dtype=np.float64)
        mono = np.asarray(np.interp(target_positions, source_positions, mono), dtype=np.float32)
    return np.ascontiguousarray(np.clip(mono, -1.0, 1.0), dtype=np.float32)


def compose_sources(
    sources: list[tuple[str, Path]],
    output: Path,
    *,
    silence_ms: int,
) -> tuple[list[TranscriptSegment], list[dict[str, object]], float, float]:
    if not 0 <= silence_ms <= 5_000:
        raise ValueError("--silence-ms must be between 0 and 5000.")
    silence = np.zeros(round(TARGET_SAMPLE_RATE * silence_ms / 1000), dtype=np.float32)
    chunks: list[np.ndarray] = []
    segments: list[TranscriptSegment] = []
    source_evidence: list[dict[str, object]] = []
    cursor = 0
    label_ordinals: dict[str, int] = {}
    for index, (label, path) in enumerate(sources):
        clip = _mono_16k(path)
        label_key = label.casefold()
        ordinal = label_ordinals.setdefault(label_key, len(label_ordinals) + 1)
        start = cursor / TARGET_SAMPLE_RATE
        end = (cursor + clip.size) / TARGET_SAMPLE_RATE
        segments.append(
            TranscriptSegment(
                id=index,
                start=round(start, 6),
                end=round(end, 6),
                text=f"synthetic voice segment {index + 1}",
                speaker=f"voice-{ordinal}",
                speaker_label=f"voice-{ordinal}",
            )
        )
        source_evidence.append(
            {
                "voiceOrdinal": ordinal,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "durationSeconds": round(clip.size / TARGET_SAMPLE_RATE, 3),
            }
        )
        chunks.append(clip)
        cursor += clip.size
        if index < len(sources) - 1 and silence.size:
            chunks.append(silence)
            cursor += silence.size

    composite = np.concatenate(chunks)
    peak = float(np.max(np.abs(composite))) if composite.size else 0.0
    if peak > 0.99:
        composite = composite * (0.99 / peak)
        peak = 0.99
    rms = float(math.sqrt(float(np.mean(np.square(composite, dtype=np.float32))))) if composite.size else 0.0
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), composite, TARGET_SAMPLE_RATE, subtype="PCM_16", format="WAV")
    return segments, source_evidence, rms, peak


def _default_output() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    return SERVICE_ROOT / "output" / "acceptance" / f"multivoice-voiceprint-{stamp}"


def summarize_diarization(payload: dict[str, object], *, expected_voices: int) -> dict[str, object]:
    raw_segments = payload.get("segments")
    segments = raw_segments if isinstance(raw_segments, list) else []
    speaker_ordinals: dict[str, int] = {}
    voiceprint_ordinals: dict[str, int] = {}
    decisions: list[dict[str, object]] = []
    covered_seconds = 0.0
    for index, raw_segment in enumerate(segments, start=1):
        if not isinstance(raw_segment, dict):
            continue
        start = float(raw_segment.get("start") or 0.0)
        end = float(raw_segment.get("end") or start)
        covered_seconds += max(0.0, end - start)
        speaker = str(raw_segment.get("speaker") or raw_segment.get("speaker_label") or "").strip()
        voiceprint = str(raw_segment.get("voiceprint_id") or "").strip()
        if speaker and speaker not in speaker_ordinals:
            speaker_ordinals[speaker] = len(speaker_ordinals) + 1
        if voiceprint and voiceprint not in voiceprint_ordinals:
            voiceprint_ordinals[voiceprint] = len(voiceprint_ordinals) + 1
        decisions.append(
            {
                "segmentOrdinal": index,
                "start": round(start, 3),
                "end": round(end, 3),
                "speakerOrdinal": speaker_ordinals.get(speaker),
                "voiceprintOrdinal": voiceprint_ordinals.get(voiceprint),
                "decision": raw_segment.get("speaker_decision"),
                "sampleDurationSeconds": raw_segment.get("speaker_sample_duration"),
            }
        )
    duration = float(payload.get("duration") or 0.0)
    speaker_count = len(speaker_ordinals)
    voiceprint_count = len(voiceprint_ordinals)
    provider_speaker_count_matched = speaker_count == expected_voices
    voiceprint_count_matched = voiceprint_count == expected_voices
    passed = len(decisions) >= expected_voices and voiceprint_count_matched
    return {
        "provider": str(payload.get("provider") or ""),
        "model": str(payload.get("model") or ""),
        "expectedVoices": expected_voices,
        "segmentCount": len(decisions),
        "anonymousSpeakerCount": speaker_count,
        "distinctVoiceprints": voiceprint_count,
        "providerSpeakerCountMatched": provider_speaker_count_matched,
        "voiceprintCountMatched": voiceprint_count_matched,
        "providerMergeCorrectedByVoiceprint": (
            speaker_count < expected_voices and voiceprint_count_matched
        ),
        "durationSeconds": round(duration, 3),
        "coveredSeconds": round(covered_seconds, 3),
        "coverage": round(covered_seconds / duration, 4) if duration > 0 else 0.0,
        "decisions": decisions,
        "passed": passed,
    }


def run_asr_diarization(
    audio_path: Path,
    *,
    model: str,
    language: str,
    expected_voices: int,
    service_url: str,
    timeout_seconds: float,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, object]:
    base_url = _loopback_base_url(service_url)
    timeout = httpx.Timeout(timeout_seconds, connect=min(15.0, timeout_seconds))
    with httpx.Client(timeout=timeout, transport=transport) as client:
        with audio_path.open("rb") as handle:
            response = client.post(
                f"{base_url}/v1/audio/transcriptions",
                files={"file": (audio_path.name, handle, "audio/wav")},
                data={
                    "model": model.strip(),
                    "language": language.strip() or "zh",
                    "response_format": "verbose_json",
                    "speaker_count": str(expected_voices),
                    "session_id": "synthetic-multivoice-diarization",
                },
            )
    if response.status_code != 200:
        raise RuntimeError(f"RabiSpeech ASR diarization failed with HTTP {response.status_code}.")
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("RabiSpeech ASR diarization returned an invalid response.")
    return summarize_diarization(payload, expected_voices=expected_voices)


def run() -> int:
    args = parse_args()
    from rabispeech.speaker_recognition import SpeakerRecognitionService

    output_dir = Path(args.output).expanduser().resolve() if args.output else _default_output().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    source_values = list(args.source or [])
    tts_voices = list(args.tts_voice or [])
    resolved_tts_model = ""
    resolved_asr_model = ""
    if bool(source_values) == bool(tts_voices):
        raise ValueError("Use either repeated --source values or repeated --tts-voice values, but not both.")
    if tts_voices:
        resolved_tts_model = resolve_model_id(
            str(args.tts_model or ""),
            capability="tts",
            service_url=args.service_url,
            timeout_seconds=float(args.request_timeout_seconds),
        )
        sources = generate_tts_sources(
            tts_voices,
            model=resolved_tts_model,
            text=str(args.tts_text or ""),
            service_url=args.service_url,
            output_dir=output_dir / "generated-sources",
            timeout_seconds=float(args.request_timeout_seconds),
        )
    else:
        sources = parse_sources(source_values)
    composite_path = output_dir / "synthetic-multivoice.wav"
    segments, source_evidence, rms, peak = compose_sources(
        sources,
        composite_path,
        silence_ms=int(args.silence_ms),
    )

    settings = load_settings(args.config)
    recognition = SpeakerRecognitionService(
        settings.speaker_recognition,
        output_dir / "speaker-embeddings.json",
    )
    duration = sf.info(str(composite_path)).duration
    analyzed = recognition.analyze(
        composite_path,
        TranscriptionResult(
            text="synthetic multi-voice composite",
            language="zh",
            duration=float(duration),
            provider="synthetic-composition-boundaries",
            model="none",
            segments=segments,
        ),
        record_id="synthetic-multivoice",
        session_id="synthetic-multivoice",
        profile_names={},
    )

    voiceprints: dict[str, int] = {}
    decisions: list[dict[str, object]] = []
    for segment in analyzed.segments:
        raw_voiceprint = str(segment.voiceprint_id or "").strip()
        cluster_ordinal = voiceprints.setdefault(raw_voiceprint, len(voiceprints) + 1) if raw_voiceprint else None
        decisions.append(
            {
                "voiceOrdinal": int(str(segment.speaker_label or "voice-0").split("-")[-1]),
                "clusterOrdinal": cluster_ordinal,
                "decision": segment.speaker_decision,
                "sampleDurationSeconds": segment.speaker_sample_duration,
                "hasVoiceprint": bool(raw_voiceprint),
            }
        )

    expected_voices = len({segment.speaker_label for segment in segments})
    rejected = {
        "voiceprint_embedding_failed",
        "voiceprint_too_short",
        "voiceprint_overlapping_speech",
    }
    explicit_boundary_passed = (
        recognition.ready
        and len(voiceprints) == expected_voices
        and all(item["hasVoiceprint"] for item in decisions)
        and not any(item["decision"] in rejected for item in decisions)
    )
    asr_diarization = None
    if args.asr_model:
        resolved_asr_model = resolve_model_id(
            str(args.asr_model),
            capability="asr",
            service_url=args.service_url,
            timeout_seconds=float(args.request_timeout_seconds),
        )
        requested_speaker_count = int(args.speaker_count or expected_voices)
        if requested_speaker_count < 1:
            raise ValueError("--speaker-count must be positive.")
        asr_diarization = run_asr_diarization(
            composite_path,
            model=resolved_asr_model,
            language=args.asr_language,
            expected_voices=requested_speaker_count,
            service_url=args.service_url,
            timeout_seconds=float(args.request_timeout_seconds),
        )
    passed = explicit_boundary_passed and (asr_diarization is None or bool(asr_diarization["passed"]))
    capability = recognition.capability()
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetKind": "synthetic_tts_composite",
        "formalValidationEligible": False,
        "boundarySource": "explicit_tts_composition",
        "limitations": [
            "Composition boundaries are known and are not evidence that ASR can diarize speakers.",
            "Synthetic TTS does not replace private real-person, real-microphone validation.",
        ],
        "generation": {
            "source": "rabispeech_tts" if tts_voices else "existing_tts_wav",
            "model": resolved_tts_model if tts_voices else None,
            "voiceCount": len(sources),
            "textStored": False,
            "voiceNamesStored": False,
        },
        "audio": {
            "sampleRate": TARGET_SAMPLE_RATE,
            "channels": 1,
            "durationSeconds": round(float(duration), 3),
            "rms": round(rms, 6),
            "peak": round(peak, 6),
            "artifact": composite_path.name,
        },
        "sources": source_evidence,
        "voiceprint": {
            "model": capability.get("model"),
            "available": capability.get("available"),
            "validated": capability.get("validated"),
            "supported": capability.get("supported"),
            "expectedVoices": expected_voices,
            "distinctVoiceprints": len(voiceprints),
            "decisions": decisions,
            "explicitBoundaryPassed": explicit_boundary_passed,
        },
        **({"asrDiarization": asr_diarization} if asr_diarization is not None else {}),
        "passed": passed,
    }
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(run())
