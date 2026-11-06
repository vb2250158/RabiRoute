from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from rabispeech.config import SpeakerRecognitionSettings
from rabispeech.speaker_recognition import SpeakerRecognitionService
from scripts.benchmark_speaker_models import (
    DatasetManifest,
    Sample,
    benchmark,
    build_validation_summary,
    equal_error_rate,
    load_policy,
    validate_result,
)
from scripts.collect_speaker_validation import SAMPLE_RATE, initialize_real_person_dataset, store_audio


def policy_payload() -> dict[str, object]:
    return {
        "schema_version": 1,
        "minimums": {
            "total_samples": 12,
            "enrolled_speakers": 2,
            "unknown_test_speakers": 1,
            "enroll_samples_per_speaker": 2,
            "known_test_samples_per_speaker": 2,
            "same_speaker_pairs": 4,
            "different_speaker_pairs": 8,
        },
        "thresholds": {
            "max_eer": 0.1,
            "max_far_at_threshold": 0.02,
            "max_frr_at_threshold": 0.2,
            "min_known_identification_accuracy": 0.9,
            "min_unknown_retention_rate": 0.9,
        },
    }


def permissive_policy_payload() -> dict[str, object]:
    return {
        "schema_version": 1,
        "minimums": {
            "total_samples": 0,
            "enrolled_speakers": 0,
            "unknown_test_speakers": 0,
            "enroll_samples_per_speaker": 0,
            "known_test_samples_per_speaker": 0,
            "same_speaker_pairs": 0,
            "different_speaker_pairs": 0,
        },
        "thresholds": {
            "max_eer": 1.0,
            "max_far_at_threshold": 1.0,
            "max_frr_at_threshold": 1.0,
            "min_known_identification_accuracy": 0.0,
            "min_unknown_retention_rate": 0.0,
        },
    }


def benchmark_result() -> dict[str, object]:
    return {
        "dataset": {
            "total_samples": 12,
            "enrolled_speakers": 2,
            "unknown_test_speakers": 1,
            "enroll_samples_per_speaker": 2,
            "known_test_samples_per_speaker": 2,
            "same_speaker_pairs": 4,
            "different_speaker_pairs": 8,
        },
        "eer": 0.05,
        "far_at_threshold": 0.01,
        "frr_at_threshold": 0.1,
        "known_identification_accuracy": 1.0,
        "unknown_retention_rate": 1.0,
    }


def test_speaker_benchmark_validation_requires_dataset_and_metric_checks() -> None:
    passed = validate_result(benchmark_result(), policy_payload())
    assert passed["passed"] is True
    assert len(passed["checks"]) == 12

    weak = benchmark_result()
    weak["far_at_threshold"] = 0.25
    weak["dataset"] = {**weak["dataset"], "unknown_test_speakers": 0}
    failed = validate_result(weak, policy_payload())
    assert failed["passed"] is False
    failed_ids = {item["id"] for item in failed["checks"] if not item["passed"]}
    assert failed_ids == {"dataset.unknown_test_speakers", "far_at_threshold"}


def test_speaker_benchmark_policy_is_explicit_and_complete(tmp_path: Path) -> None:
    policy_path = tmp_path / "policy.json"
    policy_path.write_text(json.dumps(policy_payload()), encoding="utf-8")
    assert load_policy(policy_path)["schema_version"] == 1

    incomplete = policy_payload()
    del incomplete["thresholds"]["max_eer"]
    policy_path.write_text(json.dumps(incomplete), encoding="utf-8")
    with pytest.raises(ValueError, match="max_eer"):
        load_policy(policy_path)


def test_speaker_benchmark_result_carries_model_attestation(tmp_path: Path) -> None:
    import numpy as np
    import soundfile as sf

    class Extractor:
        def __call__(self, samples, sample_rate):
            assert sample_rate == 16000
            return np.asarray([1.0, 0.0, 0.0], dtype=np.float32)

    sample_path = tmp_path / "sample.wav"
    sf.write(sample_path, np.zeros(16000, dtype=np.float32), 16000)
    result = benchmark(
        "speaker-model",
        Extractor(),
        [Sample("user", sample_path, "enroll"), Sample("user", sample_path, "test")],
        0.72,
        0.06,
        model_sha256="abc123",
    )
    assert result["model_sha256"] == "abc123"


def test_formal_validation_summary_rejects_synthetic_dataset_even_when_metrics_pass(tmp_path: Path) -> None:
    policy_path = tmp_path / "policy.json"
    policy_path.write_text(json.dumps(policy_payload()), encoding="utf-8")
    result = {"engine": "speaker-model", "validation": {"passed": True, "checks": []}}
    synthetic = DatasetManifest(
        samples=[],
        dataset_kind="synthetic_tts",
        formal_validation_eligible=False,
        sha256="1" * 64,
    )
    summary = build_validation_summary([result], policy_path=policy_path, dataset=synthetic)
    assert summary["passed"] is False
    assert summary["dataset_check"]["passed"] is False
    assert len(summary["policy_sha256"]) == 64


def test_equal_error_rate_handles_identical_same_and_different_scores() -> None:
    eer, threshold = equal_error_rate([1.0], [1.0])

    assert eer == 0.5
    assert threshold == 1.0


def test_speaker_benchmark_marks_unknown_rejection_as_correct(tmp_path: Path) -> None:
    import numpy as np
    import soundfile as sf

    class Extractor:
        def __call__(self, samples, sample_rate):
            assert sample_rate == 16000
            if float(np.mean(samples)) > 0.25:
                return np.asarray([1.0, 0.0], dtype=np.float32)
            return np.asarray([0.0, 1.0], dtype=np.float32)

    known_path = tmp_path / "known.wav"
    unknown_path = tmp_path / "unknown.wav"
    sf.write(known_path, np.full(16000, 0.5, dtype=np.float32), 16000)
    sf.write(unknown_path, np.zeros(16000, dtype=np.float32), 16000)
    result = benchmark(
        "speaker-model",
        Extractor(),
        [
            Sample("known", known_path, "enroll"),
            Sample("known", known_path, "test"),
            Sample("unknown", unknown_path, "test"),
        ],
        0.72,
        0.06,
    )

    outcomes = result["outcomes"]
    assert outcomes[0]["known"] is True
    assert outcomes[0]["correct"] is True
    assert outcomes[1]["known"] is False
    assert outcomes[1]["predicted"] is None
    assert outcomes[1]["correct"] is True
    assert result["unknown_retention_rate"] == 1.0


def test_speaker_benchmark_cli_bootstraps_from_an_arbitrary_working_directory(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "scripts" / "benchmark_speaker_models.py"
    completed = subprocess.run(
        [sys.executable, str(script), "--help"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert "--require-pass" in completed.stdout


def test_real_person_manifest_benchmark_report_enables_runtime_validation(tmp_path: Path) -> None:
    import numpy as np

    model = (
        Path(__file__).resolve().parents[4]
        / "models"
        / "rabispeech"
        / "speaker"
        / "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"
    )
    if not model.is_file():
        pytest.skip("The optional local speaker model is not installed.")

    def tone(frequency: float) -> np.ndarray:
        positions = np.arange(SAMPLE_RATE * 2, dtype=np.float32) / SAMPLE_RATE
        return (0.12 * np.sin(2 * np.pi * frequency * positions)).astype(np.float32)

    dataset = tmp_path / "real-person-fixture"
    store_audio(dataset=dataset, speaker="known", role="enroll", audio=tone(220), sample_rate=SAMPLE_RATE)
    store_audio(dataset=dataset, speaker="known", role="test", audio=tone(225), sample_rate=SAMPLE_RATE)
    store_audio(dataset=dataset, speaker="unknown", role="test", audio=tone(440), sample_rate=SAMPLE_RATE)
    initialize_real_person_dataset(dataset, confirmed=True)

    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(permissive_policy_payload()), encoding="utf-8")
    report = tmp_path / "report.json"
    script = Path(__file__).resolve().parents[1] / "scripts" / "benchmark_speaker_models.py"
    model_id = "3dspeaker-eres2netv2-zh-16k"
    completed = subprocess.run(
        [
            sys.executable,
            str(script),
            "--manifest",
            str(dataset / "speaker-cases.json"),
            "--model",
            f"{model_id}={model}",
            "--threshold",
            "0.72",
            "--margin",
            "0.06",
            "--policy",
            str(policy),
            "--require-pass",
            "--output",
            str(report),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr

    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["dataset_kind"] == "real_person_private"
    assert payload["formal_validation_eligible"] is True
    assert payload["validation"]["passed"] is True
    assert payload["results"][0]["validation"]["passed"] is True

    class RuntimeExtractor:
        dimension = 192

        def compute(self, samples, sample_rate):
            del samples, sample_rate
            return np.ones(192, dtype=np.float32)

    configured = SpeakerRecognitionSettings(
        enabled=True,
        validated=True,
        validation_report_path=report,
        experimental_auto_assign=False,
        auto_assign=True,
        model_id=model_id,
        model_path=model,
        provider="cpu",
        num_threads=1,
        min_embedding_seconds=0.8,
        hard_accept_seconds=1.5,
        hard_threshold=0.72,
        tentative_threshold=0.64,
        cluster_threshold=0.68,
        min_margin=0.06,
        max_samples_per_profile=12,
        max_unconfirmed_samples=500,
        min_voiced_rms=0.0,
    )
    capability = SpeakerRecognitionService(
        configured,
        tmp_path / "speaker-embeddings.json",
        extractor=RuntimeExtractor(),
    ).capability()
    assert capability["validated"] is True
    assert capability["supported"] is True
    assert capability["auto_assign"] is True
