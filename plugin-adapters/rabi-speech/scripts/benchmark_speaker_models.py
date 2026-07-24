from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace


PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEPENDENCY_ROOT = PLUGIN_ROOT / ".deps"
FORMAL_DATASET_KIND = "real_person_private"


def bootstrap_runtime() -> None:
    """Load RabiSpeech and its private dependencies independently of the caller's cwd."""
    for path in (DEPENDENCY_ROOT, PLUGIN_ROOT):
        value = str(path)
        if path.is_dir() and value not in sys.path:
            sys.path.insert(0, value)
    nvidia_root = DEPENDENCY_ROOT / "nvidia"
    if nvidia_root.is_dir():
        bins = [str(candidate) for candidate in sorted(nvidia_root.glob("*/bin")) if candidate.is_dir()]
        if bins:
            os.environ["PATH"] = os.pathsep.join([*bins, os.environ.get("PATH", "")])


bootstrap_runtime()

import numpy as np
import soundfile as sf

@dataclass
class Sample:
    speaker: str
    path: Path
    role: str


@dataclass
class DatasetManifest:
    samples: list[Sample]
    dataset_kind: str
    formal_validation_eligible: bool
    sha256: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark local speaker embeddings with an optional legacy spectral baseline.")
    parser.add_argument("--manifest", required=True, help="JSON with samples: [{speaker,path,role=enroll|test}].")
    parser.add_argument("--model", action="append", default=[], help="Repeat id=/absolute/model.onnx for 3D-Speaker ONNX models.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--threshold", type=float, default=0.72)
    parser.add_argument("--margin", type=float, default=0.06)
    parser.add_argument("--include-fenne-baseline", action="store_true")
    parser.add_argument("--policy", help="Explicit JSON acceptance policy for formal validation checks.")
    parser.add_argument("--require-pass", action="store_true", help="Exit 2 after writing the report when any policy check fails.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.require_pass and not args.policy:
        raise SystemExit("--require-pass requires --policy.")
    manifest = Path(args.manifest).expanduser().resolve()
    dataset = load_dataset(manifest)
    samples = dataset.samples
    policy_path = Path(args.policy).expanduser().resolve() if args.policy else None
    policy = load_policy(policy_path) if policy_path else None
    engines: list[tuple[str, object, str | None]] = []
    if args.include_fenne_baseline:
        engines.append(("fenne-spectral68", spectral_embedding, None))
    for value in args.model:
        model_id, separator, raw_path = value.partition("=")
        if not separator:
            raise SystemExit("--model must use id=/path/to/model.onnx")
        model_path = Path(raw_path).expanduser().resolve()
        engines.append((model_id.strip(), OnnxExtractor(model_path), hashlib.sha256(model_path.read_bytes()).hexdigest()))
    if not engines:
        raise SystemExit("Select --include-fenne-baseline and/or at least one --model.")
    results = [
        benchmark(engine_id, extractor, samples, args.threshold, args.margin, model_sha256=model_sha256)
        for engine_id, extractor, model_sha256 in engines
    ]
    if policy is not None:
        for result in results:
            result["validation"] = validate_result(result, policy)
    validation = None if policy is None else build_validation_summary(
        results,
        policy_path=policy_path,
        dataset=dataset,
    )
    formal_validation_eligible = bool(validation is not None and validation["passed"] is True)
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "generated_at": time.time(),
        "manifest": manifest.name,
        "dataset_manifest_sha256": dataset.sha256,
        "dataset_kind": dataset.dataset_kind,
        "formal_validation_eligible": formal_validation_eligible,
        "results": results,
    }
    if validation is not None:
        payload["validation"] = validation
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "engines": [item["engine"] for item in results],
        "validation_passed": validation["passed"] if validation is not None else None,
    }, ensure_ascii=False))
    return 2 if args.require_pass and validation is not None and not validation["passed"] else 0


class OnnxExtractor:
    def __init__(self, model: Path) -> None:
        from rabispeech.speaker_recognition import OnnxRuntimeSpeakerEmbeddingExtractor

        if not model.is_file():
            raise ValueError(f"Speaker model does not exist: {model}")
        self.extractor = OnnxRuntimeSpeakerEmbeddingExtractor(SimpleNamespace(
            model_path=model,
            num_threads=2,
            provider="cpu",
        ))

    def __call__(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        return normalize(self.extractor.compute(samples, sample_rate))


def load_samples(manifest: Path) -> list[Sample]:
    return load_dataset(manifest).samples


def load_dataset(manifest: Path) -> DatasetManifest:
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    rows = raw.get("samples") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        raise ValueError("Manifest must contain a samples array.")
    samples = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        speaker = str(row.get("speaker") or "").strip()
        role = str(row.get("role") or "test").strip().lower()
        path = Path(str(row.get("path") or "")).expanduser()
        path = (manifest.parent / path).resolve() if not path.is_absolute() else path.resolve()
        if not speaker or role not in {"enroll", "test"} or not path.is_file():
            raise ValueError(f"Invalid speaker sample: {row}")
        samples.append(Sample(speaker, path, role))
    if not samples or not any(item.role == "enroll" for item in samples) or not any(item.role == "test" for item in samples):
        raise ValueError("Manifest needs at least one enrollment and one test sample.")
    dataset_kind = str(raw.get("dataset_kind") or "unspecified").strip().lower() if isinstance(raw, dict) else "unspecified"
    formal_validation_eligible = bool(
        isinstance(raw, dict)
        and raw.get("formal_validation_eligible") is True
        and dataset_kind == FORMAL_DATASET_KIND
    )
    return DatasetManifest(
        samples=samples,
        dataset_kind=dataset_kind,
        formal_validation_eligible=formal_validation_eligible,
        sha256=hashlib.sha256(manifest.read_bytes()).hexdigest(),
    )


def build_validation_summary(
    results: list[dict[str, object]],
    *,
    policy_path: Path,
    dataset: DatasetManifest,
) -> dict[str, object]:
    dataset_check = {
        "id": "dataset.formal_validation_eligible",
        "actual": dataset.formal_validation_eligible,
        "expected": True,
        "passed": dataset.formal_validation_eligible,
    }
    engines_passed = all(bool(item["validation"]["passed"]) for item in results)
    return {
        "policy": policy_path.name,
        "policy_sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest(),
        "dataset_kind": dataset.dataset_kind,
        "dataset_check": dataset_check,
        "passed": bool(dataset_check["passed"] and engines_passed),
        "engines": [{"engine": item["engine"], **item["validation"]} for item in results],
    }


POLICY_MINIMUM_FIELDS = (
    "total_samples",
    "enrolled_speakers",
    "unknown_test_speakers",
    "enroll_samples_per_speaker",
    "known_test_samples_per_speaker",
    "same_speaker_pairs",
    "different_speaker_pairs",
)
POLICY_THRESHOLD_FIELDS = (
    "max_eer",
    "max_far_at_threshold",
    "max_frr_at_threshold",
    "min_known_identification_accuracy",
    "min_unknown_retention_rate",
)


def load_policy(path: Path) -> dict[str, object]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or int(raw.get("schema_version") or 0) != 1:
        raise ValueError("Speaker validation policy must use schema_version=1.")
    minimums = raw.get("minimums")
    thresholds = raw.get("thresholds")
    if not isinstance(minimums, dict) or not isinstance(thresholds, dict):
        raise ValueError("Speaker validation policy requires minimums and thresholds objects.")
    for field in POLICY_MINIMUM_FIELDS:
        value = minimums.get(field)
        if not isinstance(value, (int, float)) or float(value) < 0:
            raise ValueError(f"Speaker validation policy minimums.{field} must be a non-negative number.")
    for field in POLICY_THRESHOLD_FIELDS:
        value = thresholds.get(field)
        if not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
            raise ValueError(f"Speaker validation policy thresholds.{field} must be between 0 and 1.")
    return raw


def dataset_facts(samples: list[Sample], same_pairs: int, different_pairs: int) -> dict[str, int]:
    enroll_counts: dict[str, int] = {}
    test_counts: dict[str, int] = {}
    for sample in samples:
        target = enroll_counts if sample.role == "enroll" else test_counts
        target[sample.speaker] = target.get(sample.speaker, 0) + 1
    enrolled = set(enroll_counts)
    known_test_counts = [test_counts.get(speaker, 0) for speaker in enrolled]
    unknown_test_speakers = {speaker for speaker in test_counts if speaker not in enrolled}
    return {
        "total_samples": len(samples),
        "enrolled_speakers": len(enrolled),
        "unknown_test_speakers": len(unknown_test_speakers),
        "enroll_samples_per_speaker": min(enroll_counts.values(), default=0),
        "known_test_samples_per_speaker": min(known_test_counts, default=0),
        "same_speaker_pairs": same_pairs,
        "different_speaker_pairs": different_pairs,
    }


def validate_result(result: dict[str, object], policy: dict[str, object]) -> dict[str, object]:
    minimums = policy["minimums"]
    thresholds = policy["thresholds"]
    dataset = result["dataset"]
    if not isinstance(minimums, dict) or not isinstance(thresholds, dict) or not isinstance(dataset, dict):
        raise ValueError("Speaker validation result or policy is malformed.")
    checks = []

    def check(identifier: str, actual: float, operator: str, expected: float) -> None:
        passed = actual >= expected if operator == ">=" else actual <= expected
        checks.append({
            "id": identifier,
            "actual": actual,
            "operator": operator,
            "expected": expected,
            "passed": passed,
        })

    for field in POLICY_MINIMUM_FIELDS:
        check(f"dataset.{field}", float(dataset[field]), ">=", float(minimums[field]))
    metric_checks = {
        "max_eer": ("eer", "<="),
        "max_far_at_threshold": ("far_at_threshold", "<="),
        "max_frr_at_threshold": ("frr_at_threshold", "<="),
        "min_known_identification_accuracy": ("known_identification_accuracy", ">="),
        "min_unknown_retention_rate": ("unknown_retention_rate", ">="),
    }
    for policy_field, (result_field, operator) in metric_checks.items():
        check(result_field, float(result[result_field]), operator, float(thresholds[policy_field]))
    return {"passed": all(bool(item["passed"]) for item in checks), "checks": checks}


def benchmark(
    engine_id: str,
    extractor: object,
    samples: list[Sample],
    threshold: float,
    margin: float,
    *,
    model_sha256: str | None = None,
) -> dict[str, object]:
    embeddings: dict[Path, np.ndarray] = {}
    latencies = []
    durations = []
    for sample in samples:
        audio, sample_rate = sf.read(sample.path, dtype="float32", always_2d=True)
        mono = np.ascontiguousarray(audio.mean(axis=1), dtype=np.float32)
        started = time.perf_counter()
        embeddings[sample.path] = normalize(extractor(mono, sample_rate))  # type: ignore[operator]
        latencies.append((time.perf_counter() - started) * 1000.0)
        durations.append(mono.size / sample_rate)

    enroll: dict[str, list[np.ndarray]] = {}
    for sample in samples:
        if sample.role == "enroll":
            enroll.setdefault(sample.speaker, []).append(embeddings[sample.path])
    known = set(enroll)
    outcomes = []
    for sample in (item for item in samples if item.role == "test"):
        scores = sorted(
            ((speaker, multi_prototype_score(embeddings[sample.path], values)) for speaker, values in enroll.items()),
            key=lambda item: item[1],
            reverse=True,
        )
        best_name, best_score = scores[0]
        second_score = scores[1][1] if len(scores) > 1 else -1.0
        accepted = best_score >= threshold and best_score - second_score >= margin
        predicted = best_name if accepted else None
        is_known = sample.speaker in known
        outcomes.append({
            "speaker": sample.speaker,
            "known": is_known,
            "predicted": predicted,
            "score": round(best_score, 6),
            "margin": round(best_score - second_score, 6),
            "correct": predicted == sample.speaker if is_known else predicted is None,
        })

    same_scores, different_scores = pair_scores(samples, embeddings)
    eer, eer_threshold = equal_error_rate(same_scores, different_scores)
    known_rows = [item for item in outcomes if item["known"]]
    unknown_rows = [item for item in outcomes if not item["known"]]
    return {
        "engine": engine_id,
        "model_sha256": model_sha256,
        "dimensions": int(next(iter(embeddings.values())).size),
        "samples": len(samples),
        "enrolled_speakers": len(known),
        "threshold": threshold,
        "margin": margin,
        "eer": round(eer, 6),
        "eer_threshold": round(eer_threshold, 6),
        "far_at_threshold": round(rate([score >= threshold for score in different_scores]), 6),
        "frr_at_threshold": round(rate([score < threshold for score in same_scores]), 6),
        "known_identification_accuracy": round(rate([bool(item["correct"]) for item in known_rows]), 6),
        "unknown_retention_rate": round(rate([item["predicted"] is None for item in unknown_rows]), 6),
        "dataset": dataset_facts(samples, len(same_scores), len(different_scores)),
        "latency_ms_p50": round(statistics.median(latencies), 3),
        "latency_ms_p95": round(percentile(latencies, 0.95), 3),
        "rtf_p50": round(statistics.median([latency / 1000.0 / duration for latency, duration in zip(latencies, durations)]), 6),
        "outcomes": outcomes,
    }


def spectral_embedding(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if audio.size < sample_rate * 0.5:
        raise RuntimeError("Sample is shorter than the FenneNote baseline minimum.")
    audio -= float(np.mean(audio))
    peak = float(np.max(np.abs(audio)))
    if peak > 0:
        audio /= peak
    frame_size, hop = max(256, int(sample_rate * 0.025)), max(128, int(sample_rate * 0.010))
    if audio.size < frame_size:
        audio = np.pad(audio, (0, frame_size - audio.size))
    window = np.hamming(frame_size).astype(np.float32)
    vectors, energies = [], []
    for offset in range(0, audio.size - frame_size + 1, hop):
        frame = audio[offset:offset + frame_size]
        energy = float(np.sqrt(np.mean(frame * frame)))
        if energy < 0.012:
            continue
        spectrum = np.abs(np.fft.rfft(frame * window)) ** 2
        frequencies = np.fft.rfftfreq(frame_size, 1.0 / sample_rate)
        selected = spectrum[(frequencies >= 80.0) & (frequencies <= min(7600.0, sample_rate / 2.0))]
        if selected.size >= 32:
            vectors.append(np.log1p([float(np.mean(part)) for part in np.array_split(selected, 32)]))
            energies.append(energy)
    if not vectors:
        raise RuntimeError("No usable voiced frames for the FenneNote baseline.")
    matrix, energy = np.vstack(vectors), np.asarray(energies)
    return normalize(np.concatenate([matrix.mean(0), matrix.std(0), [energy.mean(), energy.std(), *np.percentile(energy, [75, 95])]]))


def multi_prototype_score(query: np.ndarray, prototypes: list[np.ndarray]) -> float:
    scores = sorted((float(np.dot(query, item)) for item in prototypes), reverse=True)[:3]
    return sum(scores) / len(scores)


def pair_scores(samples: list[Sample], embeddings: dict[Path, np.ndarray]) -> tuple[list[float], list[float]]:
    same, different = [], []
    for index, left in enumerate(samples):
        for right in samples[index + 1:]:
            score = float(np.dot(embeddings[left.path], embeddings[right.path]))
            (same if left.speaker == right.speaker else different).append(score)
    return same, different


def equal_error_rate(same: list[float], different: list[float]) -> tuple[float, float]:
    if not same or not different:
        return 0.0, 0.0
    best = (math.inf, 0.0, 0.0)
    for threshold in sorted(set([*same, *different])):
        far = rate([score >= threshold for score in different])
        frr = rate([score < threshold for score in same])
        if abs(far - frr) < best[0]:
            best = (abs(far - frr), threshold, (far + frr) / 2.0)
    return float(best[2]), float(best[1])


def normalize(value: np.ndarray) -> np.ndarray:
    vector = np.asarray(value, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm <= 1e-8:
        raise ValueError("Embedding is empty.")
    return vector / norm


def rate(values: list[bool]) -> float:
    return sum(values) / len(values) if values else 0.0


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))]


if __name__ == "__main__":
    raise SystemExit(main())
