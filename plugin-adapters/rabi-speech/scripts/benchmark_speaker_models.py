from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf


@dataclass
class Sample:
    speaker: str
    path: Path
    role: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark local speaker embeddings against the FenneNote spectral baseline.")
    parser.add_argument("--manifest", required=True, help="JSON with samples: [{speaker,path,role=enroll|test}].")
    parser.add_argument("--model", action="append", default=[], help="Repeat id=/absolute/model.onnx for sherpa-onnx models.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--threshold", type=float, default=0.72)
    parser.add_argument("--margin", type=float, default=0.06)
    parser.add_argument("--include-fenne-baseline", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = Path(args.manifest).expanduser().resolve()
    samples = load_samples(manifest)
    engines: list[tuple[str, object]] = []
    if args.include_fenne_baseline:
        engines.append(("fenne-spectral68", spectral_embedding))
    for value in args.model:
        model_id, separator, raw_path = value.partition("=")
        if not separator:
            raise SystemExit("--model must use id=/path/to/model.onnx")
        engines.append((model_id.strip(), SherpaExtractor(Path(raw_path).expanduser().resolve())))
    if not engines:
        raise SystemExit("Select --include-fenne-baseline and/or at least one --model.")
    results = [benchmark(engine_id, extractor, samples, args.threshold, args.margin) for engine_id, extractor in engines]
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"manifest": manifest.name, "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "engines": [item["engine"] for item in results]}, ensure_ascii=False))
    return 0


class SherpaExtractor:
    def __init__(self, model: Path) -> None:
        if not model.is_file():
            raise ValueError(f"Speaker model does not exist: {model}")
        import sherpa_onnx

        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(model), num_threads=2, debug=False, provider="cpu")
        if not config.validate():
            raise ValueError(f"Invalid speaker model: {model.name}")
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    def __call__(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        stream = self.extractor.create_stream()
        stream.accept_waveform(sample_rate=sample_rate, waveform=np.ascontiguousarray(samples, dtype=np.float32))
        stream.input_finished()
        if not self.extractor.is_ready(stream):
            raise RuntimeError("Speaker model did not receive enough audio.")
        return normalize(np.asarray(self.extractor.compute(stream), dtype=np.float32))


def load_samples(manifest: Path) -> list[Sample]:
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
    return samples


def benchmark(engine_id: str, extractor: object, samples: list[Sample], threshold: float, margin: float) -> dict[str, object]:
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
        outcomes.append({
            "speaker": sample.speaker,
            "known": sample.speaker in known,
            "predicted": predicted,
            "score": round(best_score, 6),
            "margin": round(best_score - second_score, 6),
            "correct": predicted == sample.speaker,
        })

    same_scores, different_scores = pair_scores(samples, embeddings)
    eer, eer_threshold = equal_error_rate(same_scores, different_scores)
    known_rows = [item for item in outcomes if item["known"]]
    unknown_rows = [item for item in outcomes if not item["known"]]
    return {
        "engine": engine_id,
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
    best = (1.0, 0.0)
    for threshold in sorted(set([*same, *different])):
        far = rate([score >= threshold for score in different])
        frr = rate([score < threshold for score in same])
        if abs(far - frr) < best[0]:
            best = (abs(far - frr), threshold, (far + frr) / 2.0)  # type: ignore[assignment]
    return float(best[2]), float(best[1])  # type: ignore[index]


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
