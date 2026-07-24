from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from scripts.collect_speaker_validation import (
    SAMPLE_RATE,
    dataset_facts,
    dataset_status,
    initialize_real_person_dataset,
    speaker_folder,
    store_audio,
)


def tone(seconds: float = 2.0, frequency: float = 220.0, amplitude: float = 0.1) -> np.ndarray:
    time = np.arange(int(SAMPLE_RATE * seconds), dtype=np.float32) / SAMPLE_RATE
    return (amplitude * np.sin(2 * np.pi * frequency * time)).astype(np.float32)


def test_private_collector_writes_standardized_audio_and_archives_manifest(tmp_path: Path) -> None:
    dataset = tmp_path / "private-speakers"
    first = store_audio(dataset=dataset, speaker="用户甲", role="enroll", audio=tone(), sample_rate=SAMPLE_RATE)
    second = store_audio(dataset=dataset, speaker="用户甲", role="test", audio=tone(frequency=240), sample_rate=SAMPLE_RATE)

    manifest = json.loads((dataset / "speaker-cases.json").read_text(encoding="utf-8"))
    assert manifest["dataset_kind"] == "unspecified"
    assert manifest["formal_validation_eligible"] is False
    assert [row["role"] for row in manifest["samples"]] == ["enroll", "test"]
    assert Path(first["path"]).parts[0] == "audio"
    assert "用户甲" not in first["path"]
    assert first["path"] != second["path"]
    assert len(list((dataset / "archive").glob("speaker-cases-*.json"))) == 1
    audio, sample_rate = sf.read(dataset / first["path"], always_2d=True)
    assert sample_rate == SAMPLE_RATE
    assert audio.shape[1] == 1
    assert dataset_status(dataset)["ready_for_benchmark"] is True


def test_private_collector_requires_explicit_real_person_dataset_declaration(tmp_path: Path) -> None:
    dataset = tmp_path / "private-speakers"
    store_audio(dataset=dataset, speaker="speaker-a", role="enroll", audio=tone(), sample_rate=SAMPLE_RATE)
    with pytest.raises(ValueError, match="confirm-real-person-recordings"):
        initialize_real_person_dataset(dataset, confirmed=False)

    status = initialize_real_person_dataset(dataset, confirmed=True)
    manifest = json.loads((dataset / "speaker-cases.json").read_text(encoding="utf-8"))
    assert status["dataset_kind"] == "real_person_private"
    assert status["formal_validation_eligible"] is True
    assert manifest["dataset_kind"] == "real_person_private"
    assert manifest["formal_validation_eligible"] is True
    assert len(list((dataset / "archive").glob("speaker-cases-*.json"))) == 1


def test_private_collector_rejects_silence_and_clipping_by_default(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="RMS"):
        store_audio(
            dataset=tmp_path / "silence",
            speaker="speaker-a",
            role="enroll",
            audio=np.zeros(SAMPLE_RATE * 2, dtype=np.float32),
            sample_rate=SAMPLE_RATE,
        )
    with pytest.raises(ValueError, match="clipping ratio"):
        store_audio(
            dataset=tmp_path / "clipped",
            speaker="speaker-a",
            role="enroll",
            audio=np.ones(SAMPLE_RATE * 2, dtype=np.float32),
            sample_rate=SAMPLE_RATE,
        )


def test_private_collector_facts_match_benchmark_policy_dimensions() -> None:
    samples = [
        {"speaker": "known-a", "role": "enroll"},
        {"speaker": "known-a", "role": "enroll"},
        {"speaker": "known-a", "role": "test"},
        {"speaker": "known-b", "role": "enroll"},
        {"speaker": "known-b", "role": "test"},
        {"speaker": "unknown-c", "role": "test"},
    ]
    assert dataset_facts(samples) == {
        "total_samples": 6,
        "enrolled_speakers": 2,
        "unknown_test_speakers": 1,
        "enroll_samples_per_speaker": 1,
        "known_test_samples_per_speaker": 1,
        "same_speaker_pairs": 4,
        "different_speaker_pairs": 11,
    }
    assert speaker_folder("用户甲") == speaker_folder("用户甲")
    assert speaker_folder("用户甲") != speaker_folder("用户乙")
