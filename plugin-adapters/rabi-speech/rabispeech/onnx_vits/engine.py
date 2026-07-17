from __future__ import annotations

import json
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from rabispeech.onnx_vits.frontend import CjkeTextFrontend


GRAPH_INPUTS = {
    "enc_p": {"x", "x_lengths"},
    "emb_g": {"sid"},
    "dp": {"x", "x_mask", "g"},
    "flow": {"z_p", "y_mask", "g"},
    "dec": {"z_in", "g"},
}
GRAPH_FILES = {name: f"{name}.onnx" for name in GRAPH_INPUTS}


class OnnxSession(Protocol):
    def run(self, output_names: Any, input_feed: dict[str, np.ndarray]) -> list[np.ndarray]: ...

    def get_inputs(self) -> list[Any]: ...


@dataclass(frozen=True)
class SynthesisResult:
    audio: np.ndarray
    sample_rate: int
    metadata: dict[str, Any]


def duration_path(durations: np.ndarray) -> np.ndarray:
    """Build the VITS monotonic attention path for one utterance."""

    values = np.asarray(durations, dtype=np.int64).reshape(-1)
    if np.any(values < 0):
        raise ValueError("VITS durations must not be negative.")
    total = int(values.sum())
    if total < 1:
        raise ValueError("VITS duration predictor produced an empty utterance.")
    path = np.zeros((1, 1, total, len(values)), dtype=np.float32)
    start = 0
    for token_index, length in enumerate(values):
        end = start + int(length)
        if end > start:
            path[0, 0, start:end, token_index] = 1.0
        start = end
    return path


def write_pcm16_wav(path: str | Path, audio: np.ndarray, sample_rate: int) -> Path:
    output = Path(path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise ValueError("Cannot write an empty WAV file.")
    samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(output), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())
    return output


class OnnxVitsEngine:
    """Cached five-graph ONNX VITS inference engine.

    The graph split matches the VITS-fast-fine-tuning export used by several
    lightweight desktop TTS applications: enc_p -> emb_g -> dp -> flow -> dec.
    Model weights and speaker metadata remain external local assets.
    """

    def __init__(
        self,
        model_dir: str | Path,
        config_path: str | Path,
        *,
        providers: list[str] | None = None,
        max_seconds: float = 120.0,
        sessions: dict[str, OnnxSession] | None = None,
        frontend: CjkeTextFrontend | None = None,
    ) -> None:
        self.model_dir = Path(model_dir).expanduser().resolve()
        self.config_path = Path(config_path).expanduser().resolve()
        if not self.config_path.is_file():
            raise FileNotFoundError(f"ONNX-VITS config not found: {self.config_path}")
        self.config = json.loads(self.config_path.read_text(encoding="utf-8-sig"))
        if not isinstance(self.config, dict):
            raise ValueError("ONNX-VITS config must be a JSON object.")
        data = self.config.get("data") if isinstance(self.config.get("data"), dict) else {}
        self.sample_rate = int(data.get("sampling_rate", 22050))
        self.hop_length = int(data.get("hop_length", 256))
        self.max_seconds = max(1.0, float(max_seconds))
        raw_speakers = self.config.get("speakers") if isinstance(self.config.get("speakers"), dict) else {}
        self.speakers = {str(name): int(speaker_id) for name, speaker_id in raw_speakers.items()}
        self.n_speakers = int(data.get("n_speakers", max(self.speakers.values(), default=-1) + 1))
        self.frontend = frontend or CjkeTextFrontend.from_config(self.config)
        self.sessions = sessions or self._load_sessions(providers)
        self._validate_graph_signatures()
        self.providers = self._session_providers()

    def _load_sessions(self, providers: list[str] | None) -> dict[str, OnnxSession]:
        try:
            import onnxruntime as ort
        except ModuleNotFoundError as exc:
            raise RuntimeError("onnxruntime is required; install the RabiSpeech ONNX-VITS dependencies.") from exc

        available = list(ort.get_available_providers())
        if providers is None:
            preferred = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
            selected = [provider for provider in preferred if provider in available]
        else:
            selected = [provider for provider in providers if provider in available]
            if not selected:
                raise RuntimeError(
                    f"None of the requested ONNX providers are available. Requested={providers}, available={available}"
                )
        if not selected:
            raise RuntimeError(f"No usable ONNX Runtime execution provider is available: {available}")

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        loaded: dict[str, OnnxSession] = {}
        for name, filename in GRAPH_FILES.items():
            path = self.model_dir / filename
            if not path.is_file():
                raise FileNotFoundError(f"ONNX-VITS graph not found: {path}")
            loaded[name] = ort.InferenceSession(str(path), sess_options=options, providers=selected)
        return loaded

    def _validate_graph_signatures(self) -> None:
        missing_graphs = sorted(set(GRAPH_INPUTS) - set(self.sessions))
        if missing_graphs:
            raise ValueError(f"Missing ONNX-VITS graph session(s): {', '.join(missing_graphs)}")
        for name, expected in GRAPH_INPUTS.items():
            session = self.sessions[name]
            getter = getattr(session, "get_inputs", None)
            if not callable(getter):
                continue
            actual = {str(item.name) for item in getter()}
            if actual != expected:
                raise ValueError(
                    f"Unexpected {name}.onnx input signature: expected {sorted(expected)}, got {sorted(actual)}"
                )

    def _session_providers(self) -> list[str]:
        getter = getattr(self.sessions["enc_p"], "get_providers", None)
        return [str(item) for item in getter()] if callable(getter) else []

    def _run(self, graph: str, **inputs: np.ndarray) -> list[np.ndarray]:
        return self.sessions[graph].run(None, inputs)

    def resolve_speaker(self, speaker: str | None = None, speaker_id: int | None = None) -> tuple[str | None, int]:
        resolved_name: str | None = None
        resolved_id: int | None = None
        if speaker:
            if speaker in self.speakers:
                resolved_name, resolved_id = speaker, self.speakers[speaker]
            else:
                matches = [(name, value) for name, value in self.speakers.items() if name.casefold() == speaker.casefold()]
                if len(matches) != 1:
                    raise ValueError(f"Unknown ONNX-VITS speaker: {speaker}")
                resolved_name, resolved_id = matches[0]
        if speaker_id is not None:
            numeric_id = int(speaker_id)
            if resolved_id is not None and resolved_id != numeric_id:
                raise ValueError(f"Speaker name resolves to {resolved_id}, not requested speaker_id {numeric_id}.")
            resolved_id = numeric_id
            resolved_name = resolved_name or next(
                (name for name, value in self.speakers.items() if value == numeric_id),
                None,
            )
        if resolved_id is None:
            raise ValueError("A fixed speaker name or speaker_id is required for ONNX-VITS synthesis.")
        if resolved_id < 0 or (self.n_speakers > 0 and resolved_id >= self.n_speakers):
            raise ValueError(f"speaker_id {resolved_id} is outside the configured range 0..{self.n_speakers - 1}.")
        return resolved_name, resolved_id

    def synthesize(
        self,
        text: str,
        *,
        speaker: str | None = None,
        speaker_id: int | None = None,
        language: str | None = None,
        speed: float = 1.0,
        noise_scale: float = 0.667,
        seed: int | None = None,
    ) -> SynthesisResult:
        token_ids = self.frontend.token_ids(text, language)
        resolved_name, resolved_id = self.resolve_speaker(speaker, speaker_id)
        return self.synthesize_token_ids(
            token_ids,
            speaker_id=resolved_id,
            speaker_name=resolved_name,
            speed=speed,
            noise_scale=noise_scale,
            seed=seed,
        )

    def synthesize_token_ids(
        self,
        token_ids: list[int],
        *,
        speaker_id: int,
        speaker_name: str | None = None,
        speed: float = 1.0,
        noise_scale: float = 0.667,
        seed: int | None = None,
    ) -> SynthesisResult:
        if not token_ids:
            raise ValueError("At least one token id is required.")
        if speaker_id < 0 or (self.n_speakers > 0 and speaker_id >= self.n_speakers):
            raise ValueError(f"speaker_id {speaker_id} is outside the configured range 0..{self.n_speakers - 1}.")
        speed = float(speed)
        noise_scale = float(noise_scale)
        if not 0.25 <= speed <= 4.0:
            raise ValueError("speed must be between 0.25 and 4.0.")
        if not 0.0 <= noise_scale <= 2.0:
            raise ValueError("noise_scale must be between 0 and 2.")

        started = time.perf_counter()
        x = np.asarray([token_ids], dtype=np.int64)
        x_lengths = np.asarray([len(token_ids)], dtype=np.int64)
        xout, m_p, logs_p, x_mask = self._run("enc_p", x=x, x_lengths=x_lengths)
        (g_flat,) = self._run("emb_g", sid=np.asarray([speaker_id], dtype=np.int64))
        g = np.asarray(g_flat, dtype=np.float32)[:, :, np.newaxis]
        (logw,) = self._run(
            "dp",
            x=np.asarray(xout, dtype=np.float32),
            x_mask=np.asarray(x_mask, dtype=np.float32),
            g=g,
        )
        length_scale = 1.0 / speed
        durations = np.ceil(np.exp(logw) * x_mask * length_scale).astype(np.int64)
        frame_count = int(durations.sum())
        max_frames = max(1, int(self.max_seconds * self.sample_rate / self.hop_length))
        if frame_count > max_frames:
            raise ValueError(
                f"Predicted audio exceeds the {self.max_seconds:g}s worker limit ({frame_count} latent frames)."
            )
        attention = duration_path(durations)
        y_mask = np.ones((1, 1, frame_count), dtype=np.float32)
        attention_matrix = attention[:, 0]
        expanded_mean = np.matmul(attention_matrix, np.transpose(m_p, (0, 2, 1))).transpose(0, 2, 1)
        expanded_logs = np.matmul(attention_matrix, np.transpose(logs_p, (0, 2, 1))).transpose(0, 2, 1)
        rng = np.random.default_rng(seed)
        latent_noise = rng.standard_normal(expanded_mean.shape, dtype=np.float32)
        z_p = expanded_mean + latent_noise * np.exp(expanded_logs) * noise_scale
        (z,) = self._run(
            "flow",
            z_p=np.asarray(z_p, dtype=np.float32),
            y_mask=y_mask,
            g=g,
        )
        (output,) = self._run("dec", z_in=np.asarray(z * y_mask, dtype=np.float32), g=g)
        audio = np.asarray(output[0, 0], dtype=np.float32)
        if audio.size == 0 or not np.isfinite(audio).all():
            raise RuntimeError("ONNX-VITS decoder returned invalid audio.")
        elapsed = time.perf_counter() - started
        duration_seconds = audio.size / self.sample_rate
        return SynthesisResult(
            audio=audio,
            sample_rate=self.sample_rate,
            metadata={
                "engine": "ONNX-VITS",
                "speaker": speaker_name,
                "speaker_id": int(speaker_id),
                "providers": list(self.providers),
                "sample_rate": self.sample_rate,
                "token_count": len(token_ids),
                "latent_frames": frame_count,
                "duration_seconds": duration_seconds,
                "generation_seconds": elapsed,
                "realtime_factor": elapsed / duration_seconds if duration_seconds > 0 else None,
                "speed": speed,
                "noise_scale": noise_scale,
            },
        )
