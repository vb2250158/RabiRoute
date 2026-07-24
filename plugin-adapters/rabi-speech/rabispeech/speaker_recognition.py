from __future__ import annotations

import hashlib
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


class OnnxRuntimeSpeakerEmbeddingExtractor:
    """Portable fallback for official 3D-Speaker ONNX models.

    ONNX Runtime loads the official speaker models directly, while
    kaldi-native-fbank supplies their declared 80-bin input features.
    """

    def __init__(self, settings: SpeakerRecognitionSettings) -> None:
        import kaldi_native_fbank as knf
        import onnxruntime as ort

        session_options = ort.SessionOptions()
        session_options.intra_op_num_threads = max(1, settings.num_threads)
        requested = settings.provider.strip().casefold()
        available = set(ort.get_available_providers())
        preferred = "CUDAExecutionProvider" if requested in {"cuda", "gpu"} else "CPUExecutionProvider"
        providers = list(dict.fromkeys(name for name in [preferred, "CPUExecutionProvider"] if name in available))
        if not providers:
            raise RuntimeError(f"No ONNX Runtime provider is available for speaker embeddings: {settings.provider}")
        self._session = ort.InferenceSession(
            str(settings.model_path),
            sess_options=session_options,
            providers=providers,
        )
        model_input = self._session.get_inputs()[0]
        model_output = self._session.get_outputs()[0]
        self._input_name = model_input.name
        self._output_name = model_output.name
        input_bins = model_input.shape[-1]
        if not isinstance(input_bins, int) or input_bins <= 0:
            raise RuntimeError("Speaker model does not declare a fixed feature dimension.")
        output_dimension = model_output.shape[-1]
        if not isinstance(output_dimension, int) or output_dimension <= 0:
            raise RuntimeError("Speaker model does not declare a fixed embedding dimension.")
        self.dimension = output_dimension
        self._sample_rate = 16_000
        self._fbank_options = knf.FbankOptions()
        self._fbank_options.frame_opts.samp_freq = self._sample_rate
        self._fbank_options.frame_opts.dither = 0.0
        self._fbank_options.frame_opts.snip_edges = True
        self._fbank_options.mel_opts.num_bins = input_bins
        self._fbank_type = knf.OnlineFbank

    def compute(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        waveform = np.ascontiguousarray(samples, dtype=np.float32).reshape(-1)
        if sample_rate <= 0 or waveform.size == 0:
            raise ValueError("Speaker embedding audio is empty.")
        if sample_rate != self._sample_rate:
            from scipy.signal import resample_poly

            common = math.gcd(sample_rate, self._sample_rate)
            waveform = np.ascontiguousarray(
                resample_poly(waveform, self._sample_rate // common, sample_rate // common),
                dtype=np.float32,
            )
        fbank = self._fbank_type(self._fbank_options)
        fbank.accept_waveform(self._sample_rate, waveform.tolist())
        fbank.input_finished()
        if fbank.num_frames_ready <= 0:
            raise RuntimeError("Speaker embedding extractor did not receive enough audio.")
        features = np.stack([fbank.get_frame(index) for index in range(fbank.num_frames_ready)]).astype(np.float32)
        features -= np.mean(features, axis=0, keepdims=True)
        embedding = self._session.run(
            [self._output_name],
            {self._input_name: features[np.newaxis, :, :]},
        )[0]
        return np.asarray(embedding, dtype=np.float32).reshape(-1)


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
        self._model_probe = model_probe or _probe_speaker_model
        self._load()
        if self._extractor is None:
            self._extractor = self._create_extractor()
        self._validation_error = self._validate_report()

    @property
    def ready(self) -> bool:
        return self._extractor is not None and self._load_error is None

    @property
    def validated(self) -> bool:
        return bool(self.settings.validated and self.ready and self._validation_error is None)

    def capability(self) -> dict[str, object]:
        model_present = self.settings.model_path.is_file()
        dependency_present = self._extractor is not None or (
            importlib.util.find_spec("onnxruntime") is not None
            and importlib.util.find_spec("kaldi_native_fbank") is not None
        )
        validated = self.validated
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
            reason = self._runtime_error or "The ONNX Runtime speaker embedding dependencies are unavailable."
        elif self.settings.validated and self._validation_error:
            reason = self._validation_error
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
            "validated": validated,
            "validation_requested": bool(self.settings.validated),
            "validation_report": self.settings.validation_report_path.name if self.settings.validation_report_path else None,
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
        provider_groups: dict[str, list[int]] = {}
        for index, segment in enumerate(result.segments):
            label = segment.speaker_label or segment.speaker or SYNTHETIC_SINGLE_SPEAKER_LABEL
            provider_groups.setdefault(label, []).append(index)

        sample_groups: list[tuple[str, str, list[int]]] = []
        sample_label_by_index: dict[int, str] = {}
        if synthetic:
            sample_groups.append((SYNTHETIC_SINGLE_SPEAKER_LABEL, SYNTHETIC_SINGLE_SPEAKER_LABEL, list(range(len(result.segments)))))
            sample_label_by_index.update({index: SYNTHETIC_SINGLE_SPEAKER_LABEL for index in range(len(result.segments))})
        else:
            for provider_label, indexes in provider_groups.items():
                if len(indexes) == 1:
                    sample_label = provider_label
                    sample_groups.append((sample_label, provider_label, indexes))
                    sample_label_by_index[indexes[0]] = sample_label
                    continue
                for turn_ordinal, index in enumerate(indexes, start=1):
                    sample_label = f"{provider_label}#turn-{turn_ordinal}"
                    sample_groups.append((sample_label, provider_label, [index]))
                    sample_label_by_index[index] = sample_label

        provider_segments = {
            label: [result.segments[index] for index in indexes]
            for label, indexes in provider_groups.items()
        }
        decisions: dict[str, dict[str, object]] = {}
        for sample_label, provider_label, indexes in sample_groups:
            segments = [result.segments[index] for index in indexes]
            if _has_cross_speaker_overlap(provider_label, provider_segments):
                decisions[sample_label] = {
                    "speaker_decision": "voiceprint_overlapping_speech",
                    "speaker_model": self.settings.model_id,
                }
                continue
            clip = _segment_audio(mono, sample_rate, segments)
            clip, duration = _voiced_audio(clip, sample_rate, self.settings.min_voiced_rms)
            if duration < self.settings.min_embedding_seconds:
                decisions[sample_label] = {
                    "speaker_decision": "voiceprint_too_short",
                    "speaker_sample_duration": round(duration, 3),
                    "speaker_model": self.settings.model_id,
                }
                continue
            try:
                embedding = _normalize(self._extractor.compute(clip, sample_rate))  # type: ignore[union-attr]
            except Exception as exc:
                self._runtime_error = f"{type(exc).__name__}: {exc}"[:500]
                decisions[sample_label] = {
                    "speaker_decision": "voiceprint_embedding_failed",
                    "speaker_sample_duration": round(duration, 3),
                    "speaker_model": self.settings.model_id,
                }
                continue
            decisions[sample_label] = self._record_and_match(
                record_id=record_id,
                session_id=session_id,
                speaker_label=sample_label,
                duration=duration,
                embedding=embedding,
                profile_names=profile_names,
            )

        enriched = []
        for index, segment in enumerate(result.segments):
            provider_label = segment.speaker_label or segment.speaker or SYNTHETIC_SINGLE_SPEAKER_LABEL
            sample_label = sample_label_by_index.get(index, provider_label)
            decision = decisions.get(sample_label, {})
            enriched.append(replace(
                segment,
                speaker=segment.speaker or (None if synthetic else provider_label),
                speaker_label=sample_label,
                speaker_id=_optional_string(decision.get("speaker_id")),
                speaker_name=_optional_string(decision.get("speaker_name")),
                speaker_decision=_optional_string(decision.get("speaker_decision")),
                speaker_cluster_id=_optional_string(decision.get("speaker_cluster_id")),
                voiceprint_id=_optional_string(decision.get("speaker_cluster_id")),
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
                and (self.validated or self.settings.experimental_auto_assign)
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
                    if hard_accept and self.validated
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

    def _validate_report(self) -> str | None:
        if not self.settings.validated:
            return None
        report_path = self.settings.validation_report_path
        if report_path is None:
            return "Speaker validation was requested, but validation_report_path is not configured."
        if not report_path.is_file():
            return "The configured speaker validation report does not exist."
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or int(payload.get("schema_version") or 0) != 1:
                return "The speaker validation report must use schema_version=1."
            if str(payload.get("dataset_kind") or "").strip().lower() != "real_person_private":
                return "The speaker validation report must use a real_person_private dataset."
            if payload.get("formal_validation_eligible") is not True:
                return "The speaker validation report is not eligible for formal validation."
            manifest_hash = str(payload.get("dataset_manifest_sha256") or "").strip().lower()
            if len(manifest_hash) != 64 or any(character not in "0123456789abcdef" for character in manifest_hash):
                return "The speaker validation report has no valid dataset manifest hash."
            overall_validation = payload.get("validation")
            if not isinstance(overall_validation, dict) or overall_validation.get("passed") is not True:
                return "The speaker validation report did not pass the complete dataset and engine policy."
            policy_hash = str(overall_validation.get("policy_sha256") or "").strip().lower()
            if len(policy_hash) != 64 or any(character not in "0123456789abcdef" for character in policy_hash):
                return "The speaker validation report has no valid policy hash."
            results = payload.get("results")
            if not isinstance(results, list):
                return "The speaker validation report has no results array."
            result = next((item for item in results if isinstance(item, dict) and item.get("engine") == self.settings.model_id), None)
            if not isinstance(result, dict):
                return "The speaker validation report does not contain the configured model id."
            validation = result.get("validation")
            if not isinstance(validation, dict) or validation.get("passed") is not True:
                return "The configured speaker model did not pass the report policy."
            if abs(float(result.get("threshold")) - self.settings.hard_threshold) > 1e-9:
                return "The speaker validation report hard threshold does not match runtime configuration."
            if abs(float(result.get("margin")) - self.settings.min_margin) > 1e-9:
                return "The speaker validation report margin does not match runtime configuration."
            expected_hash = str(result.get("model_sha256") or "").strip().lower()
            actual_hash = hashlib.sha256(self.settings.model_path.read_bytes()).hexdigest()
            if not expected_hash or expected_hash != actual_hash:
                return "The speaker validation report model hash does not match the configured model file."
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            return f"The speaker validation report is invalid: {type(exc).__name__}: {exc}"[:500]
        return None

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
            return OnnxRuntimeSpeakerEmbeddingExtractor(self.settings)
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

        # Keep at least one recent prototype for every surviving unknown cluster.
        # A purely global recency cap lets a talkative recent speaker evict a quiet
        # speaker completely, causing the same person to receive a new cluster id
        # later in a day-long recording.
        unconfirmed.sort(key=lambda item: float(item[1].get("updated_at") or 0), reverse=True)
        newest_by_cluster: dict[str, tuple[tuple[str, str], dict[str, object]]] = {}
        for item in unconfirmed:
            cluster_id = str(item[1].get("cluster_id") or "").strip()
            if cluster_id and cluster_id not in newest_by_cluster:
                newest_by_cluster[cluster_id] = item
        protected = sorted(
            newest_by_cluster.values(),
            key=lambda item: float(item[1].get("updated_at") or 0),
            reverse=True,
        )[: self.settings.max_unconfirmed_samples]
        keep = {key for key, _sample in protected}
        for key, _sample in unconfirmed:
            if len(keep) >= self.settings.max_unconfirmed_samples:
                break
            keep.add(key)
        remove.update(key for key, _sample in unconfirmed if key not in keep)
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


def _probe_speaker_model(settings: SpeakerRecognitionSettings) -> str | None:
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
    return f"Speaker model is incompatible with the current ONNX Runtime feature pipeline: {suffix}"


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
