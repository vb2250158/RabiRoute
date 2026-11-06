from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Iterable


PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEPENDENCY_ROOT = PLUGIN_ROOT / ".deps"
DEFAULT_DATASET_ROOT = PLUGIN_ROOT / "benchmarks" / "private" / "speaker-validation"
ALLOWED_PRIVATE_ROOTS = (
    (PLUGIN_ROOT / "benchmarks" / "private").resolve(),
    (PLUGIN_ROOT / "output").resolve(),
)
SAMPLE_RATE = 16_000
FORMAL_DATASET_KIND = "real_person_private"
UNSPECIFIED_DATASET_KIND = "unspecified"


def bootstrap_runtime() -> None:
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect private same/different-speaker WAVs for the RabiSpeech validation gate."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    devices = subcommands.add_parser("devices", help="List local audio input devices without recording.")
    devices.set_defaults(handler=run_devices)

    initialize = subcommands.add_parser(
        "init",
        help="Explicitly declare this private dataset as real-person recordings eligible for formal validation.",
    )
    initialize.add_argument("--dataset", default=str(DEFAULT_DATASET_ROOT))
    initialize.add_argument(
        "--confirm-real-person-recordings",
        action="store_true",
        help="Confirm that every existing and future sample in this dataset is a real-person recording, not synthetic TTS.",
    )
    initialize.set_defaults(handler=run_init)

    record = subcommands.add_parser("record", help="Record one speaker into the private validation dataset.")
    add_common_sample_arguments(record)
    record.add_argument("--count", type=int, default=1)
    record.add_argument("--seconds", type=float, default=5.0)
    record.add_argument("--device", help="SoundDevice input index or device name.")
    record.add_argument("--countdown", type=int, default=3)
    record.set_defaults(handler=run_record)

    add = subcommands.add_parser("add", help="Import existing WAV files into the private validation dataset.")
    add_common_sample_arguments(add)
    add.add_argument("--file", action="append", required=True, help="Repeat for each source WAV.")
    add.set_defaults(handler=run_add)

    status = subcommands.add_parser("status", help="Show dataset counts and optional policy minimum checks.")
    status.add_argument("--dataset", default=str(DEFAULT_DATASET_ROOT))
    status.add_argument("--policy", help="Optional validation policy JSON.")
    status.set_defaults(handler=run_status)
    return parser.parse_args()


def add_common_sample_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--speaker", required=True, help="Private stable label used only inside this dataset.")
    parser.add_argument("--role", choices=("enroll", "test"), required=True)
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET_ROOT))
    parser.add_argument("--min-rms", type=float, default=0.01)
    parser.add_argument("--max-clipping-ratio", type=float, default=0.01)
    parser.add_argument("--allow-low-quality", action="store_true")


def main() -> int:
    args = parse_args()
    return int(args.handler(args))


def run_devices(_args: argparse.Namespace) -> int:
    import sounddevice as sd

    rows = []
    for index, device in enumerate(sd.query_devices()):
        if int(device.get("max_input_channels") or 0) <= 0:
            continue
        rows.append({
            "index": index,
            "name": str(device.get("name") or ""),
            "input_channels": int(device.get("max_input_channels") or 0),
            "default_sample_rate": float(device.get("default_samplerate") or 0),
        })
    print(json.dumps({"devices": rows}, ensure_ascii=False, indent=2))
    return 0


def run_init(args: argparse.Namespace) -> int:
    result = initialize_real_person_dataset(
        Path(args.dataset),
        confirmed=bool(args.confirm_real_person_recordings),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def initialize_real_person_dataset(dataset: Path, *, confirmed: bool) -> dict[str, object]:
    if not confirmed:
        raise ValueError("Formal speaker validation requires --confirm-real-person-recordings.")
    root = private_dataset_root(dataset)
    manifest_path = root / "speaker-cases.json"
    manifest = load_manifest(manifest_path)
    manifest["dataset_kind"] = FORMAL_DATASET_KIND
    manifest["formal_validation_eligible"] = True
    manifest["updated_at"] = time.time()
    atomic_write_manifest(manifest_path, manifest)
    return dataset_status(root)


def run_record(args: argparse.Namespace) -> int:
    count = max(1, min(100, int(args.count)))
    seconds = float(args.seconds)
    if not 1.0 <= seconds <= 30.0:
        raise SystemExit("--seconds must be between 1 and 30.")
    device = parse_device(args.device)
    saved = []
    for index in range(count):
        countdown = max(0, min(10, int(args.countdown)))
        for remaining in range(countdown, 0, -1):
            print(f"sample {index + 1}/{count}: recording starts in {remaining}...", flush=True)
            time.sleep(1)
        print(f"sample {index + 1}/{count}: recording {seconds:.1f}s", flush=True)
        audio = record_audio(seconds, device)
        saved.append(store_audio(
            dataset=Path(args.dataset),
            speaker=str(args.speaker),
            role=str(args.role),
            audio=audio,
            sample_rate=SAMPLE_RATE,
            min_rms=float(args.min_rms),
            max_clipping_ratio=float(args.max_clipping_ratio),
            allow_low_quality=bool(args.allow_low_quality),
        ))
    print(json.dumps({"saved": saved, "status": dataset_status(Path(args.dataset))}, ensure_ascii=False, indent=2))
    return 0


def run_add(args: argparse.Namespace) -> int:
    saved = []
    for value in args.file:
        source = Path(value).expanduser().resolve()
        if not source.is_file():
            raise SystemExit(f"Source WAV does not exist: {source}")
        audio, sample_rate = sf.read(source, dtype="float32", always_2d=True)
        saved.append(store_audio(
            dataset=Path(args.dataset),
            speaker=str(args.speaker),
            role=str(args.role),
            audio=audio.mean(axis=1),
            sample_rate=int(sample_rate),
            min_rms=float(args.min_rms),
            max_clipping_ratio=float(args.max_clipping_ratio),
            allow_low_quality=bool(args.allow_low_quality),
        ))
    print(json.dumps({"saved": saved, "status": dataset_status(Path(args.dataset))}, ensure_ascii=False, indent=2))
    return 0


def run_status(args: argparse.Namespace) -> int:
    result: dict[str, object] = dataset_status(Path(args.dataset))
    if args.policy:
        policy_path = Path(args.policy).expanduser().resolve()
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        minimums = policy.get("minimums") if isinstance(policy, dict) else None
        if not isinstance(minimums, dict):
            raise SystemExit("Policy must contain a minimums object.")
        facts = result["facts"]
        if not isinstance(facts, dict):
            raise SystemExit("Dataset facts are unavailable.")
        result["minimum_checks"] = [
            {
                "id": key,
                "actual": int(facts.get(key) or 0),
                "expected": int(value),
                "passed": int(facts.get(key) or 0) >= int(value),
            }
            for key, value in minimums.items()
        ]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def parse_device(value: str | None) -> int | str | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    return int(normalized) if re.fullmatch(r"\d+", normalized) else normalized


def record_audio(seconds: float, device: int | str | None) -> np.ndarray:
    import sounddevice as sd

    frames = int(round(seconds * SAMPLE_RATE))
    captured = sd.rec(frames, samplerate=SAMPLE_RATE, channels=1, dtype="float32", device=device)
    sd.wait()
    return np.ascontiguousarray(captured.reshape(-1), dtype=np.float32)


def store_audio(
    *,
    dataset: Path,
    speaker: str,
    role: str,
    audio: np.ndarray,
    sample_rate: int,
    min_rms: float = 0.01,
    max_clipping_ratio: float = 0.01,
    allow_low_quality: bool = False,
) -> dict[str, object]:
    root = private_dataset_root(dataset)
    label = speaker.strip()
    normalized_role = role.strip().lower()
    if not label:
        raise ValueError("Speaker label is required.")
    if normalized_role not in {"enroll", "test"}:
        raise ValueError("Sample role must be enroll or test.")
    mono = standardize_audio(audio, sample_rate)
    quality = audio_quality(mono)
    problems = []
    if quality["duration_seconds"] < 1.0:
        problems.append("duration is shorter than 1 second")
    if quality["rms"] < max(0.0, min_rms):
        problems.append(f"RMS {quality['rms']:.6f} is below {min_rms:.6f}")
    if quality["clipping_ratio"] > max(0.0, max_clipping_ratio):
        problems.append(f"clipping ratio {quality['clipping_ratio']:.6f} exceeds {max_clipping_ratio:.6f}")
    if problems and not allow_low_quality:
        raise ValueError("Speaker sample rejected: " + "; ".join(problems))

    manifest_path = root / "speaker-cases.json"
    manifest = load_manifest(manifest_path)
    folder = root / "audio" / speaker_folder(label)
    folder.mkdir(parents=True, exist_ok=True)
    sequence = next_sequence(manifest["samples"], label, normalized_role)
    target = folder / f"{normalized_role}-{sequence:03d}.wav"
    while target.exists():
        sequence += 1
        target = folder / f"{normalized_role}-{sequence:03d}.wav"
    temporary = target.with_name(f".{target.name}.{os.getpid()}.{time.time_ns()}.tmp.wav")
    try:
        sf.write(temporary, mono, SAMPLE_RATE, subtype="PCM_16")
        os.replace(temporary, target)
        relative = target.relative_to(root).as_posix()
        row = {"speaker": label, "role": normalized_role, "path": relative}
        manifest["samples"].append(row)
        manifest["updated_at"] = time.time()
        atomic_write_manifest(manifest_path, manifest)
    except Exception:
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise
    return {**row, "quality": quality, "quality_overridden": bool(problems and allow_low_quality)}


def standardize_audio(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    if sample_rate <= 0:
        raise ValueError("Sample rate must be positive.")
    value = np.asarray(audio, dtype=np.float32)
    if value.ndim == 2:
        value = value.mean(axis=1)
    value = np.nan_to_num(value.reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)
    if sample_rate != SAMPLE_RATE and value.size:
        target_size = max(1, int(round(value.size * SAMPLE_RATE / sample_rate)))
        source_positions = np.arange(value.size, dtype=np.float64)
        target_positions = np.linspace(0.0, max(0.0, value.size - 1.0), target_size, dtype=np.float64)
        value = np.interp(target_positions, source_positions, value).astype(np.float32)
    return np.ascontiguousarray(np.clip(value, -1.0, 1.0), dtype=np.float32)


def audio_quality(audio: np.ndarray) -> dict[str, float]:
    if audio.size == 0:
        return {"duration_seconds": 0.0, "rms": 0.0, "peak": 0.0, "clipping_ratio": 0.0}
    absolute = np.abs(audio)
    return {
        "duration_seconds": round(float(audio.size) / SAMPLE_RATE, 6),
        "rms": round(float(np.sqrt(np.mean(audio * audio))), 6),
        "peak": round(float(np.max(absolute)), 6),
        "clipping_ratio": round(float(np.mean(absolute >= 0.995)), 6),
    }


def private_dataset_root(value: Path) -> Path:
    root = value.expanduser().resolve()
    plugin_root = PLUGIN_ROOT.resolve()
    if is_relative_to(root, plugin_root) and not any(is_relative_to(root, allowed) for allowed in ALLOWED_PRIVATE_ROOTS):
        raise ValueError("Speaker validation data inside the repository must stay under benchmarks/private or output.")
    root.mkdir(parents=True, exist_ok=True)
    return root


def load_manifest(path: Path) -> dict[str, object]:
    if not path.exists():
        return {
            "schema_version": 1,
            "updated_at": time.time(),
            "dataset_kind": UNSPECIFIED_DATASET_KIND,
            "formal_validation_eligible": False,
            "samples": [],
        }
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("samples"), list):
        raise ValueError("Speaker validation manifest must contain a samples array.")
    rows = []
    root = path.parent.resolve()
    for row in raw["samples"]:
        if not isinstance(row, dict):
            raise ValueError("Speaker validation manifest rows must be objects.")
        relative = Path(str(row.get("path") or ""))
        target = (root / relative).resolve()
        if relative.is_absolute() or not is_relative_to(target, root):
            raise ValueError("Speaker validation sample paths must stay inside the dataset.")
        rows.append({
            "speaker": str(row.get("speaker") or "").strip(),
            "role": str(row.get("role") or "").strip().lower(),
            "path": relative.as_posix(),
        })
    dataset_kind = str(raw.get("dataset_kind") or UNSPECIFIED_DATASET_KIND).strip().lower()
    formal_validation_eligible = bool(
        raw.get("formal_validation_eligible") is True
        and dataset_kind == FORMAL_DATASET_KIND
    )
    return {
        "schema_version": 1,
        "updated_at": raw.get("updated_at") or time.time(),
        "dataset_kind": dataset_kind,
        "formal_validation_eligible": formal_validation_eligible,
        "samples": rows,
    }


def atomic_write_manifest(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        archive = path.parent / "archive" / f"speaker-cases-{time.time_ns()}.json"
        archive.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, archive)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def dataset_status(dataset: Path) -> dict[str, object]:
    root = private_dataset_root(dataset)
    manifest = load_manifest(root / "speaker-cases.json")
    samples = manifest["samples"]
    if not isinstance(samples, list):
        raise ValueError("Speaker validation samples are unavailable.")
    facts = dataset_facts(samples)
    return {
        "dataset": str(root),
        "manifest": str(root / "speaker-cases.json"),
        "dataset_kind": str(manifest.get("dataset_kind") or UNSPECIFIED_DATASET_KIND),
        "formal_validation_eligible": manifest.get("formal_validation_eligible") is True,
        "facts": facts,
        "ready_for_benchmark": facts["enrolled_speakers"] > 0 and facts["known_test_samples_per_speaker"] > 0,
    }


def dataset_facts(samples: Iterable[dict[str, object]]) -> dict[str, int]:
    rows = list(samples)
    counts: dict[str, int] = {}
    enroll: dict[str, int] = {}
    tests: dict[str, int] = {}
    for row in rows:
        speaker = str(row.get("speaker") or "")
        role = str(row.get("role") or "")
        counts[speaker] = counts.get(speaker, 0) + 1
        target = enroll if role == "enroll" else tests
        target[speaker] = target.get(speaker, 0) + 1
    enrolled = set(enroll)
    same_pairs = sum(count * (count - 1) // 2 for count in counts.values())
    total_pairs = len(rows) * (len(rows) - 1) // 2
    return {
        "total_samples": len(rows),
        "enrolled_speakers": len(enrolled),
        "unknown_test_speakers": len({speaker for speaker in tests if speaker not in enrolled}),
        "enroll_samples_per_speaker": min(enroll.values(), default=0),
        "known_test_samples_per_speaker": min((tests.get(speaker, 0) for speaker in enrolled), default=0),
        "same_speaker_pairs": same_pairs,
        "different_speaker_pairs": total_pairs - same_pairs,
    }


def next_sequence(samples: object, speaker: str, role: str) -> int:
    if not isinstance(samples, list):
        return 1
    return 1 + sum(1 for row in samples if isinstance(row, dict) and row.get("speaker") == speaker and row.get("role") == role)


def speaker_folder(speaker: str) -> str:
    prefix = re.sub(r"[^a-z0-9]+", "-", speaker.lower()).strip("-")[:16] or "speaker"
    digest = hashlib.sha256(speaker.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}-{digest}"


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
