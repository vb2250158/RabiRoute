from __future__ import annotations

import argparse
import csv
import gc
import json
import math
import platform
import re
import shutil
import statistics
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TERMINAL_JOB_STATES = {"done", "error", "failed", "missing"}


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def local_opener() -> urllib.request.OpenerDirector:
    # Local worker traffic must never fall through a system HTTP proxy.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> Any:
    body = None
    headers: dict[str, str] = {}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with local_opener().open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def nvidia_snapshot() -> dict[str, float] | None:
    command = [
        "nvidia-smi",
        "--query-gpu=memory.used,utilization.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=5, check=True)
        line = completed.stdout.strip().splitlines()[0]
        memory, utilization, power = [float(item.strip()) for item in line.split(",")[:3]]
        return {"memory_mib": memory, "utilization_percent": utilization, "power_w": power}
    except (FileNotFoundError, IndexError, ValueError, subprocess.SubprocessError):
        return None


@dataclass
class GpuProbe:
    interval: float = 0.2

    def __post_init__(self) -> None:
        self.samples: list[dict[str, float]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.samples = []
        self._stop.clear()

        def sample_loop() -> None:
            while not self._stop.is_set():
                sample = nvidia_snapshot()
                if sample:
                    sample["monotonic_seconds"] = time.perf_counter()
                    self.samples.append(sample)
                self._stop.wait(self.interval)

        self._thread = threading.Thread(target=sample_loop, name="benchmark-gpu-probe", daemon=True)
        self._thread.start()

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        if not self.samples:
            return {"sample_count": 0}
        memory = [item["memory_mib"] for item in self.samples]
        utilization = [item["utilization_percent"] for item in self.samples]
        power = [item["power_w"] for item in self.samples]
        return {
            "sample_count": len(self.samples),
            "memory_start_mib": memory[0],
            "memory_peak_mib": max(memory),
            "memory_delta_peak_mib": max(memory) - memory[0],
            "utilization_peak_percent": max(utilization),
            "utilization_mean_percent": statistics.fmean(utilization),
            "power_peak_w": max(power),
        }


def wav_stats(path: Path) -> dict[str, Any]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frame_count = handle.getnframes()
        frames = handle.readframes(frame_count)
    duration = frame_count / sample_rate if sample_rate else 0.0
    if sample_width != 2 or not frames:
        return {
            "duration_seconds": duration,
            "sample_rate_hz": sample_rate,
            "channels": channels,
            "sample_width_bytes": sample_width,
            "bytes": path.stat().st_size,
        }

    import array

    values = array.array("h")
    values.frombytes(frames)
    if not values:
        peak_fraction = 0.0
        rms_dbfs = None
        clipped_fraction = 0.0
    else:
        peak_fraction = max(abs(value) for value in values) / 32768.0
        square_mean = sum(float(value) * float(value) for value in values) / len(values)
        rms_fraction = math.sqrt(square_mean) / 32768.0
        rms_dbfs = 20 * math.log10(rms_fraction) if rms_fraction > 0 else None
        clipped_fraction = sum(abs(value) >= 32760 for value in values) / len(values)
    return {
        "duration_seconds": round(duration, 6),
        "sample_rate_hz": sample_rate,
        "channels": channels,
        "sample_width_bytes": sample_width,
        "bytes": path.stat().st_size,
        "peak_fraction": round(peak_fraction, 6),
        "rms_dbfs": round(rms_dbfs, 3) if rms_dbfs is not None else None,
        "clipped_fraction": round(clipped_fraction, 8),
    }


def normalize_transcript(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return "".join(char for char in normalized if char.isalnum() or "\u4e00" <= char <= "\u9fff")


def edit_distance(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, start=1):
        current = [row]
        for column, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def cer(reference: str, hypothesis: str) -> dict[str, Any]:
    normalized_reference = normalize_transcript(reference)
    normalized_hypothesis = normalize_transcript(hypothesis)
    errors = edit_distance(normalized_reference, normalized_hypothesis)
    denominator = len(normalized_reference)
    return {
        "normalized_reference": normalized_reference,
        "normalized_hypothesis": normalized_hypothesis,
        "character_errors": errors,
        "reference_characters": denominator,
        "cer": errors / denominator if denominator else None,
    }


def sanitize_name(value: str) -> str:
    value = re.sub(r"[^0-9A-Za-z._-]+", "-", value.strip())
    return value.strip("-") or "sample"


def benchmark_tts(args: argparse.Namespace) -> None:
    texts = read_json(Path(args.texts))
    if not isinstance(texts, list) or not texts:
        raise ValueError("--texts must be a non-empty JSON array")
    output_path = Path(args.output).resolve()
    audio_dir = output_path.parent / "audio" / sanitize_name(args.engine)
    audio_dir.mkdir(parents=True, exist_ok=True)
    base_url = args.url.rstrip("/")
    health = request_json("GET", f"{base_url}/health", timeout=10)
    records: list[dict[str, Any]] = []

    for index, sample in enumerate(texts):
        sample_id = str(sample.get("id") or f"sample-{index + 1}")
        payload: dict[str, Any] = {
            "text": str(sample["text"]),
            "play": False,
            "language": args.language,
        }
        if args.character_id:
            payload["character_id"] = args.character_id
        if args.character_folder:
            payload["character_folder"] = str(Path(args.character_folder).resolve())
        if args.prompt_audio:
            payload["prompt_audio"] = str(Path(args.prompt_audio).resolve())
        if args.speaker_id is not None:
            payload["speaker_id"] = args.speaker_id
        if args.speaker:
            payload["speaker"] = args.speaker
        if args.max_new_tokens:
            payload["max_new_tokens"] = args.max_new_tokens

        probe = GpuProbe(interval=args.gpu_sample_interval)
        probe.start()
        started = time.perf_counter()
        job = request_json("POST", f"{base_url}/speak", payload=payload, timeout=30)
        acknowledged = time.perf_counter()
        job_id = str(job["id"])
        status = str(job.get("status", "queued"))
        while status not in TERMINAL_JOB_STATES:
            time.sleep(args.poll_interval)
            job = request_json("GET", f"{base_url}/status/{urllib.parse.quote(job_id)}", timeout=30)
            status = str(job.get("status", ""))
            if time.perf_counter() - started > args.job_timeout:
                status = "timeout"
                break
        completed = time.perf_counter()
        gpu = probe.stop()
        if status != "done":
            raise RuntimeError(f"{args.engine} job {job_id} ended as {status}: {job.get('error')}")

        source_audio = Path(str(job["output"])).resolve()
        target_audio = audio_dir / f"{index + 1:02d}-{sanitize_name(sample_id)}.wav"
        shutil.copy2(source_audio, target_audio)
        audio = wav_stats(target_audio)
        completion_seconds = completed - started
        records.append(
            {
                "engine": args.engine,
                "run_order": index + 1,
                "run_class": "first-request" if index == 0 else "warm",
                "sample_id": sample_id,
                "reference_text": str(sample["text"]),
                "job_id": job_id,
                "status": status,
                "ack_seconds": acknowledged - started,
                "completion_seconds": completion_seconds,
                "generation_rtf": completion_seconds / audio["duration_seconds"] if audio["duration_seconds"] else None,
                "worker_output": str(source_audio),
                "benchmark_audio": str(target_audio),
                "worker_job": job,
                "audio": audio,
                "gpu": gpu,
            }
        )

    payload = {
        "schema_version": 1,
        "kind": "tts-benchmark",
        "generated_at": utc_timestamp(),
        "engine": args.engine,
        "worker_url": base_url,
        "health_before": health,
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "gpu_before": nvidia_snapshot(),
        },
        "records": records,
    }
    write_json(output_path, payload)
    print(json.dumps({"ok": True, "output": str(output_path), "records": len(records)}, ensure_ascii=False))


def benchmark_asr(args: argparse.Namespace) -> None:
    from faster_whisper import WhisperModel

    tts_payloads = [read_json(Path(path)) for path in args.tts_results]
    audio_rows = [record for payload in tts_payloads for record in payload.get("records", [])]
    if not audio_rows:
        raise ValueError("No TTS records were found")

    model_root = str(Path(args.model_root).resolve())
    probe = GpuProbe(interval=args.gpu_sample_interval)
    probe.start()
    load_started = time.perf_counter()
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=model_root,
        local_files_only=True,
    )
    load_seconds = time.perf_counter() - load_started
    load_gpu = probe.stop()
    warmup: dict[str, Any] | None = None
    if args.warmup_audio:
        warmup_path = Path(args.warmup_audio).resolve()
        probe = GpuProbe(interval=args.gpu_sample_interval)
        probe.start()
        warmup_started = time.perf_counter()
        warmup_segments, warmup_info = model.transcribe(
            str(warmup_path),
            beam_size=args.beam_size,
            vad_filter=args.vad_filter,
            language=args.language,
        )
        warmup_transcript = "".join(segment.text for segment in warmup_segments).strip()
        warmup = {
            "audio_path": str(warmup_path),
            "elapsed_seconds": time.perf_counter() - warmup_started,
            "transcript": warmup_transcript,
            "detected_language": getattr(warmup_info, "language", None),
            "gpu": probe.stop(),
        }
    records: list[dict[str, Any]] = []

    for index, source in enumerate(audio_rows):
        audio_path = Path(str(source["benchmark_audio"])).resolve()
        probe = GpuProbe(interval=args.gpu_sample_interval)
        probe.start()
        started = time.perf_counter()
        segments, info = model.transcribe(
            str(audio_path),
            beam_size=args.beam_size,
            vad_filter=args.vad_filter,
            language=args.language,
        )
        transcript = "".join(segment.text for segment in segments).strip()
        elapsed = time.perf_counter() - started
        gpu = probe.stop()
        audio = wav_stats(audio_path)
        score = cer(str(source["reference_text"]), transcript)
        records.append(
            {
                "model": args.model,
                "device": args.device,
                "compute_type": args.compute_type,
                "run_order": index + 1,
                "run_class": "first-transcription" if index == 0 else "warm",
                "tts_engine": source["engine"],
                "sample_id": source["sample_id"],
                "audio_path": str(audio_path),
                "audio_duration_seconds": audio["duration_seconds"],
                "elapsed_seconds": elapsed,
                "transcription_rtf": elapsed / audio["duration_seconds"] if audio["duration_seconds"] else None,
                "reference_text": source["reference_text"],
                "transcript": transcript,
                "detected_language": getattr(info, "language", None),
                "language_probability": getattr(info, "language_probability", None),
                **score,
                "gpu": gpu,
            }
        )

    total_errors = sum(record["character_errors"] for record in records)
    total_characters = sum(record["reference_characters"] for record in records)
    payload = {
        "schema_version": 1,
        "kind": "asr-benchmark",
        "generated_at": utc_timestamp(),
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
        "model_root": model_root,
        "model_load_seconds": load_seconds,
        "model_load_gpu": load_gpu,
        "unscored_warmup": warmup,
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "gpu_after_load": nvidia_snapshot(),
        },
        "summary": {
            "samples": len(records),
            "micro_cer": total_errors / total_characters if total_characters else None,
            "mean_elapsed_seconds": statistics.fmean(record["elapsed_seconds"] for record in records),
            "mean_rtf": statistics.fmean(record["transcription_rtf"] for record in records),
        },
        "records": records,
    }
    write_json(Path(args.output).resolve(), payload)
    del model
    gc.collect()
    print(json.dumps({"ok": True, "output": str(Path(args.output).resolve()), **payload["summary"]}, ensure_ascii=False))


def export_csv(args: argparse.Namespace) -> None:
    payloads = [read_json(Path(path)) for path in args.inputs]
    rows: list[dict[str, Any]] = []
    for payload in payloads:
        for record in payload.get("records", []):
            flat = {
                key: value
                for key, value in record.items()
                if not isinstance(value, (dict, list))
            }
            for group in ("audio", "gpu"):
                for key, value in (record.get(group) or {}).items():
                    if not isinstance(value, (dict, list)):
                        flat[f"{group}_{key}"] = value
            rows.append(flat)
    fields = sorted({key for row in rows for key in row})
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({"ok": True, "output": str(output), "rows": len(rows)}, ensure_ascii=False))


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def write_rows_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = sorted({key for row in rows for key in row})
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def summarize_results(args: argparse.Namespace) -> None:
    tts_payloads = [read_json(Path(path)) for path in args.tts]
    asr_payloads = [read_json(Path(path)) for path in args.asr]
    tts_summary: list[dict[str, Any]] = []
    for payload in tts_payloads:
        records = list(payload.get("records", []))
        if not records:
            continue
        ready_before = bool((payload.get("health_before") or {}).get("ready"))
        warm = records if ready_before else records[1:]
        warm_seconds = [float(record["completion_seconds"]) for record in warm]
        warm_rtf = [float(record["generation_rtf"]) for record in warm]
        first = records[0]
        baseline = float((first.get("gpu") or {}).get("memory_start_mib") or 0)
        peak = max(float((record.get("gpu") or {}).get("memory_peak_mib") or baseline) for record in records)
        tts_summary.append(
            {
                "engine": payload["engine"],
                "worker_ready_before": ready_before,
                "first_request_class": "already-warm" if ready_before else "cold-lazy-load",
                "first_request_seconds": first["completion_seconds"],
                "first_request_audio_seconds": first["audio"]["duration_seconds"],
                "first_request_rtf": first["generation_rtf"],
                "warm_samples": len(warm),
                "warm_mean_seconds": statistics.fmean(warm_seconds),
                "warm_median_seconds": statistics.median(warm_seconds),
                "warm_p95_seconds": percentile(warm_seconds, 0.95),
                "warm_mean_rtf": statistics.fmean(warm_rtf),
                "warm_median_rtf": statistics.median(warm_rtf),
                "warm_p95_rtf": percentile(warm_rtf, 0.95),
                "gpu_baseline_mib": baseline,
                "gpu_peak_mib": peak,
                "gpu_incremental_peak_mib": peak - baseline,
                "sample_rate_hz": first["audio"]["sample_rate_hz"],
                "max_clipped_fraction": max(float(record["audio"].get("clipped_fraction") or 0) for record in records),
                "mean_rms_dbfs": statistics.fmean(float(record["audio"]["rms_dbfs"]) for record in records),
            }
        )

    asr_summary: list[dict[str, Any]] = []
    asr_by_source: list[dict[str, Any]] = []
    for payload in asr_payloads:
        records = list(payload.get("records", []))
        elapsed = [float(record["elapsed_seconds"]) for record in records]
        rtfs = [float(record["transcription_rtf"]) for record in records]
        warmup_seconds = float((payload.get("unscored_warmup") or {}).get("elapsed_seconds") or 0)
        asr_summary.append(
            {
                "model": payload["model"],
                "device": payload["device"],
                "compute_type": payload["compute_type"],
                "model_load_seconds": payload["model_load_seconds"],
                "warmup_seconds": warmup_seconds,
                "ready_after_seconds": float(payload["model_load_seconds"]) + warmup_seconds,
                "samples": len(records),
                "mean_seconds": statistics.fmean(elapsed),
                "median_seconds": statistics.median(elapsed),
                "p95_seconds": percentile(elapsed, 0.95),
                "mean_rtf": statistics.fmean(rtfs),
                "median_rtf": statistics.median(rtfs),
                "p95_rtf": percentile(rtfs, 0.95),
                "micro_cer": payload["summary"]["micro_cer"],
                "load_gpu_incremental_peak_mib": (payload.get("model_load_gpu") or {}).get("memory_delta_peak_mib"),
                "warmup_gpu_peak_mib": (payload.get("unscored_warmup") or {}).get("gpu", {}).get("memory_peak_mib"),
            }
        )
        sources = sorted({record["tts_engine"] for record in records})
        for source in sources:
            group = [record for record in records if record["tts_engine"] == source]
            errors = sum(int(record["character_errors"]) for record in group)
            characters = sum(int(record["reference_characters"]) for record in group)
            asr_by_source.append(
                {
                    "model": payload["model"],
                    "tts_engine": source,
                    "samples": len(group),
                    "micro_cer": errors / characters if characters else None,
                    "mean_seconds": statistics.fmean(float(record["elapsed_seconds"]) for record in group),
                    "mean_rtf": statistics.fmean(float(record["transcription_rtf"]) for record in group),
                }
            )

    result = {
        "schema_version": 1,
        "kind": "model-benchmark-summary",
        "generated_at": utc_timestamp(),
        "tts": tts_summary,
        "asr": asr_summary,
        "asr_by_tts_source": asr_by_source,
    }
    output = Path(args.output).resolve()
    write_json(output, result)
    csv_dir = Path(args.csv_dir).resolve()
    write_rows_csv(csv_dir / "tts-summary.csv", tts_summary)
    write_rows_csv(csv_dir / "asr-summary.csv", asr_summary)
    write_rows_csv(csv_dir / "asr-by-tts-source.csv", asr_by_source)
    print(json.dumps({"ok": True, "output": str(output), "csv_dir": str(csv_dir)}, ensure_ascii=False))


def public_tts_record(record: dict[str, Any]) -> dict[str, Any]:
    audio = record.get("audio") or {}
    gpu = record.get("gpu") or {}
    return {
        "engine": record.get("engine"),
        "run_order": record.get("run_order"),
        "run_class": record.get("run_class"),
        "sample_id": record.get("sample_id"),
        "reference_text": record.get("reference_text"),
        "completion_seconds": record.get("completion_seconds"),
        "generation_rtf": record.get("generation_rtf"),
        "audio_duration_seconds": audio.get("duration_seconds"),
        "sample_rate_hz": audio.get("sample_rate_hz"),
        "rms_dbfs": audio.get("rms_dbfs"),
        "clipped_fraction": audio.get("clipped_fraction"),
        "gpu_memory_delta_peak_mib": gpu.get("memory_delta_peak_mib"),
    }


def public_asr_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "model": record.get("model"),
        "tts_engine": record.get("tts_engine"),
        "sample_id": record.get("sample_id"),
        "reference_text": record.get("reference_text"),
        "transcript": record.get("transcript"),
        "cer": record.get("cer"),
        "character_errors": record.get("character_errors"),
        "reference_characters": record.get("reference_characters"),
        "elapsed_seconds": record.get("elapsed_seconds"),
        "transcription_rtf": record.get("transcription_rtf"),
    }


def safe_embedded_json(payload: Any) -> str:
    # Keep an application/json script block inert even if future public test text
    # contains HTML-like content.
    return (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def render_html_report(args: argparse.Namespace) -> None:
    summary = read_json(Path(args.summary))
    texts = read_json(Path(args.texts))
    metadata = read_json(Path(args.metadata))
    tts_payloads = [read_json(Path(path)) for path in args.tts]
    asr_payloads = [read_json(Path(path)) for path in args.asr]
    report_payload = {
        "schema_version": 1,
        "generated_at": utc_timestamp(),
        "summary": summary,
        "texts": texts,
        "metadata": metadata,
        "ttsRecords": [
            public_tts_record(record)
            for payload in tts_payloads
            for record in payload.get("records", [])
        ],
        "asrRecords": [
            public_asr_record(record)
            for payload in asr_payloads
            for record in payload.get("records", [])
        ],
    }
    template_path = Path(args.template).resolve()
    template = template_path.read_text(encoding="utf-8")
    placeholder = "__RABISPEECH_REPORT_PAYLOAD__"
    if template.count(placeholder) != 1:
        raise ValueError(f"HTML template must contain exactly one {placeholder} placeholder")
    rendered = template.replace(placeholder, safe_embedded_json(report_payload))
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8", newline="\n")
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(output),
                "tts_records": len(report_payload["ttsRecords"]),
                "asr_records": len(report_payload["asrRecords"]),
            },
            ensure_ascii=False,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reproducible local RabiSpeech TTS/ASR model benchmark")
    subparsers = parser.add_subparsers(dest="command", required=True)

    tts = subparsers.add_parser("tts", help="Benchmark one already-running local TTS worker")
    tts.add_argument("--engine", required=True)
    tts.add_argument("--url", required=True)
    tts.add_argument("--texts", required=True)
    tts.add_argument("--output", required=True)
    tts.add_argument("--language", default="Chinese")
    tts.add_argument("--character-id")
    tts.add_argument("--character-folder")
    tts.add_argument("--prompt-audio")
    tts.add_argument("--speaker")
    tts.add_argument("--speaker-id", type=int)
    tts.add_argument("--max-new-tokens", type=int)
    tts.add_argument("--poll-interval", type=float, default=0.1)
    tts.add_argument("--job-timeout", type=float, default=900)
    tts.add_argument("--gpu-sample-interval", type=float, default=0.2)
    tts.set_defaults(func=benchmark_tts)

    asr = subparsers.add_parser("asr", help="Benchmark one cached faster-whisper model")
    asr.add_argument("--model", required=True)
    asr.add_argument("--model-root", required=True)
    asr.add_argument("--tts-results", action="append", required=True)
    asr.add_argument("--output", required=True)
    asr.add_argument("--device", default="cuda")
    asr.add_argument("--compute-type", default="int8_float16")
    asr.add_argument("--beam-size", type=int, default=5)
    asr.add_argument("--vad-filter", action=argparse.BooleanOptionalAction, default=True)
    asr.add_argument("--language", default="zh")
    asr.add_argument("--warmup-audio")
    asr.add_argument("--gpu-sample-interval", type=float, default=0.2)
    asr.set_defaults(func=benchmark_asr)

    export = subparsers.add_parser("export-csv", help="Flatten benchmark JSON records to CSV")
    export.add_argument("--inputs", action="append", required=True)
    export.add_argument("--output", required=True)
    export.set_defaults(func=export_csv)

    summarize = subparsers.add_parser("summarize", help="Create report-ready summary tables")
    summarize.add_argument("--tts", action="append", required=True)
    summarize.add_argument("--asr", action="append", required=True)
    summarize.add_argument("--output", required=True)
    summarize.add_argument("--csv-dir", required=True)
    summarize.set_defaults(func=summarize_results)

    render_html = subparsers.add_parser("render-html", help="Render a self-contained benchmark HTML report")
    render_html.add_argument("--summary", required=True)
    render_html.add_argument("--texts", required=True)
    render_html.add_argument("--metadata", required=True)
    render_html.add_argument("--template", required=True)
    render_html.add_argument("--tts", action="append", required=True)
    render_html.add_argument("--asr", action="append", required=True)
    render_html.add_argument("--output", required=True)
    render_html.set_defaults(func=render_html_report)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
