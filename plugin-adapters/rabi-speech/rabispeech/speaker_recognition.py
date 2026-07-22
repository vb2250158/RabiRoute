from __future__ import annotations

import json
import importlib.util
import math
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Callable, Protocol

import numpy as np
import soundfile as sf

from .config import SpeakerRecognitionSettings
from .contracts import TranscriptSegment, TranscriptionResult


STORE_VERSION = 1
SYNTHETIC_SINGLE_SPEAKER_LABEL = "voice"
MAX_CROSS_SPEAKER_OVERLAP_SECONDS = 0.12
MATCH_PROTOTYPE_COUNT = 3


class SpeakerEmbeddingExtractor(Protocol):
    dimension: int

    def compute(self, samples: np.ndarray, sample_rate: int) -> np.ndarray: ...


class SherpaOnnxSpeakerEmbeddingExtractor:
    def __init__(self, settings: SpeakerRecognitionSettings) -> None:
        import sherpa_onnx

        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(settings.model_path),
            num_threads=settings.num_threads,
            debug=False,
            provider=settings.provider,
        )
        if not config.validate():
            raise RuntimeError("Invalid sherpa-onnx speaker embedding configuration.")
        self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        self.dimension = int(self._extractor.dim)

    def compute(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        stream = self._extractor.create_stream()
        stream.accept_waveform(sample_rate=sample_rate, waveform=np.ascontiguousarray(samples, dtype=np.float32))
        stream.input_finished()
        if not self._extractor.is_ready(stream):
            raise RuntimeError("Speaker embedding extractor did not receive enough audio.")
        return np.asarray(self._extractor.compute(stream), dtype=np.float32)


class SpeakerRecognitionService:
    """Optional local speaker embedding, conservative matching, and unknown clustering.

    Raw enrollment audio is never copied. The runtime store contains only local
    embeddings and record-scoped metadata; public snapshots omit vectors.
    """

    def __init__(
        self,
        settings: SpeakerRecognitionSettings,
        path: str | Path,
        *,
        extractor: SpeakerEmbeddingExtractor | None = None,
        model_probe: Callable[[SpeakerRecognitionSettings], str | None] | None = None,
    ) -> None:
        self.settings = settings
        self.path = Path(path).expanduser().resolve()
        self._lock = threading.RLock()
        self._samples: dict[tuple[str, str], dict[str, object]] = {}
        self._load_error: str | None = None
        self._runtime_error: str | None = None
        self._extractor = extractor
        self._model_probe = model_probe or _probe_sherpa_model
        self._load()
        if self._extractor is None:
            self._extractor = self._create_extractor()

    @property
    def ready(self) -> bool:
        return self._extractor is not None and self._load_error is None

    def capability(self) -> dict[str, object]:
        model_present = self.settings.model_path.is_file()
        dependency_present = self._extractor is not None or importlib.util.find_spec("sherpa_onnx") is not None
        validated = bool(self.settings.validated and self.ready)
        experimental_auto_assign = bool(
            self.settings.experimental_auto_assign
            and self.settings.auto_assign
            and self.ready
            and not validated
        )
        if not self.settings.enabled:
            reason = "Speaker recognition is disabled by local configuration."
        elif not model_present:
            reason = "The configured local speaker embedding model is not installed."
        elif self._load_error:
            reason = f"The local speaker embedding store is unreadable: {self._load_error}"
        elif not self.ready:
            reason = self._runtime_error or "The sherpa-onnx speaker embedding dependency is unavailable."
        elif experimental_auto_assign:
            reason = "The local matcher is available with conservative experimental auto-assignment; formal benchmark validation is still pending."
        elif not self.settings.validated:
            reason = "The model is available, but local thresholds have not passed the speaker benchmark yet."
        else:
            reason = "Validated local embedding matcher is available."
        return {
            "supported": validated,
            "available": self.ready,
            "experimental": self.ready and not validated,
            "reason": reason,
            "model": self.settings.model_id,
            "provider": self.settings.provider,
            "model_present": model_present,
            "dependency_present": dependency_present,
            "validated": bool(self.settings.validated),
            "experimental_auto_assign": experimental_auto_assign,
            "auto_assign": bool(self.settings.auto_assign and (validated or experimental_auto_assign)),
            "thresholds": {
                "min_embedding_seconds": self.settings.min_embedding_seconds,
                "hard_accept_seconds": self.settings.hard_accept_seconds,
                "hard_threshold": self.settings.hard_threshold,
                "tentative_threshold": self.settings.tentative_threshold,
                "cluster_threshold": self.settings.cluster_threshold,
                "min_margin": self.settings.min_margin,
                "min_voiced_rms": self.settings.min_voiced_rms,
            },
            "storage_limits": {
                "max_samples_per_profile": self.settings.max_samples_per_profile,
                "max_unconfirmed_samples": self.settings.max_unconfirmed_samples,
            },
        }

    def public_clusters(self) -> list[dict[str, object]]:
        with self._lock:
            grouped: dict[str, list[dict[str, object]]] = {}
            for sample in self._samples.values():
                if sample.get("confirmed_speaker_id") or sample.get("matched_speaker_id"):
                    continue
                cluster_id = str(sample.get("cluster_id") or "").strip()
                if cluster_id:
                    grouped.setdefault(cluster_id, []).append(sample)
            rows = []
            for cluster_id, samples in grouped.items():
                rows.append({
                    "id": cluster_id,
                    "sample_count": len(samples),
                    "total_duration": round(sum(float(item.get("duration") or 0) for item in samples), 3),
                    "last_seen_at": max(float(item.get("updated_at") or 0) for item in samples),
                })
            return sorted(rows, key=lambda item: float(item["last_seen_at"]), reverse=True)

    def analyze(
        self,
        audio_path: str | Path,
        result: TranscriptionResult,
        *,
        record_id: str,
        session_id: str | None,
        profile_names: dict[str, str],
    ) -> TranscriptionResult:
        if not self.ready or not result.segments:
            return replace(result, record_id=record_id)
        samples, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
        mono = np.ascontiguousarray(samples.mean(axis=1), dtype=np.float32)
        labels = [segment.speaker_label or segment.speaker for segment in result.segments]
        synthetic = not any(labels)
        grouped: dict[str, list[TranscriptSegment]] = {}
        for segment in result.segments:
            label = segment.speaker_label or segment.speaker or SYNTHETIC_SINGLE_SPEAKER_LABEL
            grouped.setdefault(label, []).append(segment)

        decisions: dict[str, dict[str, object]] = {}
        for label, segments in grouped.items():
            if _has_cross_speaker_overlap(label, grouped):
                decisions[label] = {
                    "speaker_decision": "voiceprint_overlapping_speech",
                    "speaker_model": self.settings.model_id,
                }
                continue
            clip = _segment_audio(mono, sample_rate, segments)
            clip, duration = _voiced_audio(clip, sample_rate, self.settings.min_voiced_rms)
            if duration < self.settings.min_embedding_seconds:
                decisions[label] = {
                    "speaker_decision": "voiceprint_too_short",
                    "speaker_sample_duration": round(duration, 3),
                    "speaker_model": self.settings.model_id,
                }
                continue
            try:
                embedding = _normalize(self._extractor.compute(clip, sample_rate))  # type: ignore[union-attr]
            except Exception as exc:
                self._runtime_error = f"{type(exc).__name__}: {exc}"[:500]
                decisions[label] = {
                    "speaker_decision": "voiceprint_embedding_failed",
                    "speaker_sample_duration": round(duration, 3),
                    "speaker_model": self.settings.model_id,
                }
                continue
            decisions[label] = self._record_and_match(
                record_id=record_id,
                session_id=session_id,
                speaker_label=label,
                duration=duration,
                embedding=embedding,
                profile_names=profile_names,
            )

        enriched = []
        for segment in result.segments:
            label = segment.speaker_label or segment.speaker or SYNTHETIC_SINGLE_SPEAKER_LABEL
            decision = decisions.get(label, {})
            enriched.append(replace(
                segment,
                speaker=segment.speaker or (None if synthetic else label),
                speaker_label=label,
                speaker_id=_optional_string(decision.get("speaker_id")),
                speaker_name=_optional_string(decision.get("speaker_name")),
                speaker_decision=_optional_string(decision.get("speaker_decision")),
                speaker_cluster_id=_optional_string(decision.get("speaker_cluster_id")),
                speaker_score=_optional_float(decision.get("speaker_score")),
                speaker_margin=_optional_float(decision.get("speaker_margin")),
                speaker_sample_duration=_optional_float(decision.get("speaker_sample_duration")),
                speaker_model=_optional_string(decision.get("speaker_model")),
                speaker_suggestion_id=_optional_string(decision.get("speaker_suggestion_id")),
                speaker_suggestion_name=_optional_string(decision.get("speaker_suggestion_name")),
            ))
        return replace(result, segments=enriched, record_id=record_id)

    def confirm(self, record_id: str, speaker_label: str, speaker_id: str) -> bool:
        key = (record_id, speaker_label.casefold())
        with self._lock:
            sample = self._samples.get(key)
            if sample is None:
                return False
            sample["confirmed_speaker_id"] = speaker_id
            sample["matched_speaker_id"] = None
            sample["updated_at"] = time.time()
            self._prune_samples()
            self._persist()
            return True

    def unconfirm(self, record_id: str, speaker_label: str) -> bool:
        key = (record_id, speaker_label.casefold())
        with self._lock:
            sample = self._samples.get(key)
            if sample is None or not sample.get("confirmed_speaker_id"):
                return False
            sample["confirmed_speaker_id"] = None
            sample["updated_at"] = time.time()
            self._prune_samples()
            self._persist()
            return True

    def forget_profile(self, speaker_id: str) -> int:
        changed = 0
        with self._lock:
            for sample in self._samples.values():
                if sample.get("confirmed_speaker_id") == speaker_id:
                    sample["confirmed_speaker_id"] = None
                    sample["updated_at"] = time.time()
                    changed += 1
                if sample.get("matched_speaker_id") == speaker_id:
                    sample["matched_speaker_id"] = None
                    sample["updated_at"] = time.time()
                    changed += 1
            if changed:
                self._prune_samples()
                self._persist()
        return changed

    def _record_and_match(
        self,
        *,
        record_id: str,
        session_id: str | None,
        speaker_label: str,
        duration: float,
        embedding: np.ndarray,
        profile_names: dict[str, str],
    ) -> dict[str, object]:
        with self._lock:
            profile_scores = self._profile_scores(embedding)
            best_id, best_score = profile_scores[0] if profile_scores else (None, -1.0)
            second_score = profile_scores[1][1] if len(profile_scores) > 1 else -1.0
            margin = best_score - second_score if best_id else 0.0
            hard_accept = bool(
                best_id
                and (self.settings.validated or self.settings.experimental_auto_assign)
                and self.settings.auto_assign
                and duration >= self.settings.hard_accept_seconds
                and best_score >= self.settings.hard_threshold
                and margin >= self.settings.min_margin
            )
            tentative = bool(best_id and best_score >= self.settings.tentative_threshold)
            cluster_id = self._match_cluster(embedding)
            now = time.time()
            sample = {
                "record_id": record_id,
                "session_id": session_id,
                "speaker_label": speaker_label,
                "model_id": self.settings.model_id,
                "embedding": embedding.astype(float).tolist(),
                "duration": round(duration, 3),
                "cluster_id": cluster_id,
                "confirmed_speaker_id": None,
                "matched_speaker_id": best_id if hard_accept else None,
                "created_at": now,
                "updated_at": now,
            }
            self._samples[(record_id, speaker_label.casefold())] = sample
            self._prune_samples()
            self._persist()
            decision: dict[str, object] = {
                "speaker_decision": (
                    "voiceprint_auto_match"
                    if hard_accept and self.settings.validated
                    else "voiceprint_experimental_auto_match"
                    if hard_accept
                    else
                    "voiceprint_tentative_known" if tentative else "voiceprint_unknown_cluster"
                ),
                "speaker_cluster_id": cluster_id,
                "speaker_score": round(best_score, 6) if best_id else None,
                "speaker_margin": round(margin, 6) if best_id else None,
                "speaker_sample_duration": round(duration, 3),
                "speaker_model": self.settings.model_id,
            }
            if best_id:
                decision["speaker_suggestion_id"] = best_id
                decision["speaker_suggestion_name"] = profile_names.get(best_id)
            if hard_accept and best_id:
                decision["speaker_id"] = best_id
                decision["speaker_name"] = profile_names.get(best_id)
            return decision

    def _profile_scores(self, embedding: np.ndarray) -> list[tuple[str, float]]:
        grouped: dict[str, list[float]] = {}
        for sample in self._samples.values():
            speaker_id = str(sample.get("confirmed_speaker_id") or "").strip()
            if not speaker_id or sample.get("model_id") != self.settings.model_id:
                continue
            stored = _stored_embedding(sample)
            if stored is not None and stored.size == embedding.size:
                grouped.setdefault(speaker_id, []).append(float(np.dot(stored, embedding)))
        scores = []
        for speaker_id, values in grouped.items():
            top = sorted(values, reverse=True)[: min(MATCH_PROTOTYPE_COUNT, self.settings.max_samples_per_profile)]
            scores.append((speaker_id, float(sum(top) / len(top))))
        return sorted(scores, key=lambda item: item[1], reverse=True)

    def _match_cluster(self, embedding: np.ndarray) -> str:
        grouped: dict[str, list[np.ndarray]] = {}
        for sample in self._samples.values():
            if (
                sample.get("confirmed_speaker_id")
                or sample.get("matched_speaker_id")
                or sample.get("model_id") != self.settings.model_id
            ):
                continue
            cluster_id = str(sample.get("cluster_id") or "").strip()
            stored = _stored_embedding(sample)
            if cluster_id and stored is not None and stored.size == embedding.size:
                grouped.setdefault(cluster_id, []).append(stored)
        best_id = ""
        best_score = -1.0
        for cluster_id, values in grouped.items():
            centroid = _normalize(np.mean(np.stack(values), axis=0))
            score = float(np.dot(centroid, embedding))
            if score > best_score:
                best_id, best_score = cluster_id, score
        return best_id if best_id and best_score >= self.settings.cluster_threshold else f"cluster-{uuid.uuid4().hex[:12]}"

    def _create_extractor(self) -> SpeakerEmbeddingExtractor | None:
        if not self.settings.enabled or not self.settings.model_path.is_file():
            return None
        probe_error = self._model_probe(self.settings)
        if probe_error:
            self._runtime_error = probe_error[:500]
            return None
        try:
            return SherpaOnnxSpeakerEmbeddingExtractor(self.settings)
        except Exception as exc:
            self._runtime_error = f"{type(exc).__name__}: {exc}"[:500]
            return None

    def _prune_samples(self) -> None:
        confirmed_by_profile: dict[str, list[tuple[tuple[str, str], dict[str, object]]]] = {}
        unconfirmed: list[tuple[tuple[str, str], dict[str, object]]] = []
        for key, sample in self._samples.items():
            speaker_id = str(sample.get("confirmed_speaker_id") or "").strip()
            if speaker_id:
                confirmed_by_profile.setdefault(speaker_id, []).append((key, sample))
            else:
                unconfirmed.append((key, sample))

        remove: set[tuple[str, str]] = set()
        for rows in confirmed_by_profile.values():
            rows.sort(key=lambda item: float(item[1].get("updated_at") or 0), reverse=True)
            remove.update(key for key, _sample in rows[self.settings.max_samples_per_profile:])
        unconfirmed.sort(key=lambda item: float(item[1].get("updated_at") or 0), reverse=True)
        remove.update(key for key, _sample in unconfirmed[self.settings.max_unconfirmed_samples:])
        for key in remove:
            self._samples.pop(key, None)

    def _load(self) -> None:
        if not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            for value in raw.get("samples") or []:
                if not isinstance(value, dict):
                    continue
                record_id = str(value.get("record_id") or "").strip()
                speaker_label = str(value.get("speaker_label") or "").strip()
                embedding = value.get("embedding")
                if record_id and speaker_label and isinstance(embedding, list) and embedding:
                    self._samples[(record_id, speaker_label.casefold())] = value
            self._prune_samples()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self._samples.clear()
            self._load_error = f"{type(exc).__name__}: {exc}"[:500]

    def _persist(self) -> None:
        if self._load_error:
            raise RuntimeError("Speaker embedding store is unreadable and cannot be updated safely.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        payload = {"version": STORE_VERSION, "updated_at": time.time(), "samples": list(self._samples.values())}
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as output:
                json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)


def _segment_audio(samples: np.ndarray, sample_rate: int, segments: list[TranscriptSegment]) -> np.ndarray:
    chunks = []
    for segment in sorted(segments, key=lambda item: (item.start, item.end)):
        start = max(0, min(samples.size, int(math.floor(max(0.0, segment.start) * sample_rate))))
        end = max(start, min(samples.size, int(math.ceil(max(segment.start, segment.end) * sample_rate))))
        if end > start:
            chunks.append(samples[start:end])
    return np.ascontiguousarray(np.concatenate(chunks) if chunks else samples, dtype=np.float32)


def _voiced_audio(samples: np.ndarray, sample_rate: int, min_rms: float) -> tuple[np.ndarray, float]:
    if sample_rate <= 0 or samples.size == 0:
        return np.asarray([], dtype=np.float32), 0.0
    frame_size = max(1, int(sample_rate * 0.025))
    chunks: list[np.ndarray] = []
    for offset in range(0, samples.size, frame_size):
        frame = samples[offset:offset + frame_size]
        if frame.size and float(np.sqrt(np.mean(frame * frame))) >= min_rms:
            chunks.append(frame)
    voiced = np.ascontiguousarray(np.concatenate(chunks) if chunks else np.asarray([], dtype=np.float32))
    return voiced, float(voiced.size) / float(sample_rate)


def _has_cross_speaker_overlap(
    speaker_label: str,
    grouped: dict[str, list[TranscriptSegment]],
) -> bool:
    own = grouped.get(speaker_label, [])
    others = [segment for label, segments in grouped.items() if label != speaker_label for segment in segments]
    overlap = 0.0
    for left in own:
        for right in others:
            overlap += max(0.0, min(left.end, right.end) - max(left.start, right.start))
            if overlap > MAX_CROSS_SPEAKER_OVERLAP_SECONDS:
                return True
    return False


def _probe_sherpa_model(settings: SpeakerRecognitionSettings) -> str | None:
    probe = Path(__file__).resolve().parents[1] / "scripts" / "speaker_model_probe.py"
    if not probe.is_file():
        return f"Speaker model compatibility probe is missing: {probe}"
    try:
        completed = subprocess.run(
            [
                sys.executable,
                str(probe),
                "--model",
                str(settings.model_path),
                "--provider",
                settings.provider,
                "--num-threads",
                str(settings.num_threads),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"Speaker model compatibility probe failed: {type(exc).__name__}: {exc}"
    if completed.returncode == 0:
        return None
    detail = (completed.stderr or completed.stdout or "").strip().splitlines()
    suffix = detail[-1] if detail else f"exit code {completed.returncode}"
    return f"Speaker model is incompatible with the current sherpa-onnx runtime: {suffix}"


def _normalize(value: np.ndarray) -> np.ndarray:
    flattened = np.asarray(value, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(flattened))
    if not math.isfinite(norm) or norm <= 1e-8:
        raise ValueError("Speaker embedding has no usable magnitude.")
    return flattened / norm


def _stored_embedding(sample: dict[str, object]) -> np.ndarray | None:
    value = sample.get("embedding")
    if not isinstance(value, list) or not value:
        return None
    try:
        return _normalize(np.asarray(value, dtype=np.float32))
    except (TypeError, ValueError):
        return None


def _optional_string(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _optional_float(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else None
