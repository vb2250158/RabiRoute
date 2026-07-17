from __future__ import annotations

import asyncio
import gc
import tempfile
import threading
import wave
from pathlib import Path
from typing import Any

from ..config import FasterWhisperSettings
from ..contracts import TranscriptSegment, TranscriptionRequest, TranscriptionResult


class FasterWhisperProvider:
    provider_id = "faster-whisper"

    def __init__(self, settings: FasterWhisperSettings) -> None:
        self.settings = settings
        self._model: Any = None
        self._loaded_model_id = ""
        self._loaded_device = ""
        self._warmup_error = ""
        self._model_lock = threading.Lock()
        self._transcribe_lock = asyncio.Lock()

    def capabilities(self) -> dict[str, object]:
        models = []
        for spec in self.settings.models:
            installed = self._model_installed(spec.id)
            models.append(
                {
                    "id": spec.id,
                    "name": spec.name,
                    "family": "Whisper",
                    "source": spec.source,
                    "installed": installed,
                    "loaded": self._model is not None and self._loaded_model_id == spec.id,
                    "languages": ["multilingual"],
                    "features": ["transcription", "language_hint", "segment_timestamps", "word_timestamps", "vad"],
                }
            )
        return {
            "kind": "asr",
            "enabled": self.settings.enabled,
            "model": self.settings.model,
            "model_root": str(self.settings.model_root),
            "local_files_only": self.settings.local_files_only,
            "loaded": self._model is not None,
            "loaded_device": self._loaded_device,
            "preload": self.settings.preload,
            "warmup_error": self._warmup_error,
            "models": models,
            "formats": ["wav", "mp3", "flac", "m4a", "ogg", "opus", "webm", "mp4"],
        }

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.settings.enabled:
            raise RuntimeError("faster-whisper ASR provider is disabled.")
        model_id = self._resolve_model(request.model)
        if not self._model_installed(model_id):
            raise ValueError(f"Local faster-whisper model is not installed: {model_id}")
        async with self._transcribe_lock:
            try:
                result = await asyncio.to_thread(self._transcribe_sync, request, None, model_id)
                self._warmup_error = ""
                return result
            except Exception as exc:
                self._warmup_error = f"{type(exc).__name__}: {exc}"
                raise

    async def warmup(self) -> None:
        if not self.settings.enabled or not self.settings.preload:
            return
        handle = tempfile.NamedTemporaryFile(prefix="rabispeech-warmup-", suffix=".wav", delete=False)
        path = Path(handle.name)
        handle.close()
        try:
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"\x00\x00" * 4000)
            request = TranscriptionRequest(audio_path=path, model="asr-local", language="zh")
            async with self._transcribe_lock:
                await asyncio.to_thread(self._transcribe_sync, request, False, self.settings.model)
            self._warmup_error = ""
        except Exception as exc:
            # Keep the service available for diagnostics and a later retry.
            self._warmup_error = f"{type(exc).__name__}: {exc}"
            return
        finally:
            path.unlink(missing_ok=True)

    def _transcribe_sync(
        self,
        request: TranscriptionRequest,
        vad_filter: bool | None = None,
        model_id: str | None = None,
    ) -> TranscriptionResult:
        selected_model = model_id or self._resolve_model(request.model)
        model = self._ensure_model(selected_model)
        try:
            segments, info = self._run_model(model, request, vad_filter)
            return self._result(segments, info, request, selected_model)
        except Exception:
            if self._loaded_device != "cuda" or self.settings.device not in {"auto", "cuda"}:
                raise
            # Some CTranslate2 builds finish model construction before loading
            # CUDA runtime DLLs. Treat a first inference failure as part of the
            # auto-device probe and retry once on CPU.
            self._release_model()
            cpu_model = self._load_model("cpu", selected_model)
            segments, info = self._run_model(cpu_model, request, vad_filter)
            return self._result(segments, info, request, selected_model)

    def _run_model(self, model: Any, request: TranscriptionRequest, vad_filter: bool | None = None) -> tuple[Any, Any]:
        return model.transcribe(
            str(request.audio_path),
            language=request.language or None,
            initial_prompt=request.prompt or None,
            beam_size=self.settings.beam_size,
            vad_filter=self.settings.vad_filter if vad_filter is None else vad_filter,
            word_timestamps=request.word_timestamps,
        )

    def _result(self, segments: Any, info: Any, request: TranscriptionRequest, model_id: str) -> TranscriptionResult:
        rows: list[TranscriptSegment] = []
        texts: list[str] = []
        for index, segment in enumerate(segments):
            text = str(segment.text or "").strip()
            if text:
                texts.append(text)
            words = []
            for word in list(getattr(segment, "words", None) or []):
                words.append(
                    {
                        "word": str(getattr(word, "word", "")),
                        "start": float(getattr(word, "start", 0.0) or 0.0),
                        "end": float(getattr(word, "end", 0.0) or 0.0),
                        "probability": float(getattr(word, "probability", 0.0) or 0.0),
                    }
                )
            rows.append(
                TranscriptSegment(
                    id=index,
                    start=float(segment.start or 0.0),
                    end=float(segment.end or 0.0),
                    text=text,
                    words=words,
                )
            )
        return TranscriptionResult(
            text="".join(texts).strip(),
            language=str(getattr(info, "language", request.language or "") or ""),
            duration=float(getattr(info, "duration", 0.0) or 0.0),
            provider=self.provider_id,
            model=model_id,
            segments=rows,
        )

    def _ensure_model(self, model_id: str) -> Any:
        if self._model is not None and self._loaded_model_id == model_id:
            return self._model
        with self._model_lock:
            if self._model is not None and self._loaded_model_id == model_id:
                return self._model
            self._release_model()
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError(
                    "faster-whisper is not installed. Run scripts/install.ps1 for RabiSpeech."
                ) from exc
            self.settings.model_root.mkdir(parents=True, exist_ok=True)
            requested_device = self.settings.device
            candidates = [requested_device] if requested_device != "auto" else ["cuda", "cpu"]
            if requested_device == "cuda":
                candidates.append("cpu")
            errors: list[str] = []
            for device in dict.fromkeys(candidates):
                compute_type = self.settings.cpu_compute_type if device == "cpu" else self.settings.compute_type
                try:
                    self._model = WhisperModel(
                        self._model_source(model_id),
                        device=device,
                        compute_type=compute_type,
                        download_root=str(self.settings.model_root),
                        local_files_only=self.settings.local_files_only,
                    )
                    self._loaded_device = device
                    self._loaded_model_id = model_id
                    return self._model
                except Exception as exc:  # CUDA loader errors vary by ctranslate2 build.
                    errors.append(f"{device}: {type(exc).__name__}: {exc}")
            raise RuntimeError("Unable to load the local Whisper model. " + " | ".join(errors))

    def _load_model(self, device: str, model_id: str) -> Any:
        from faster_whisper import WhisperModel

        compute_type = self.settings.cpu_compute_type if device == "cpu" else self.settings.compute_type
        self._model = WhisperModel(
            self._model_source(model_id),
            device=device,
            compute_type=compute_type,
            download_root=str(self.settings.model_root),
            local_files_only=self.settings.local_files_only,
        )
        self._loaded_device = device
        self._loaded_model_id = model_id
        return self._model

    def _resolve_model(self, requested: str) -> str:
        normalized = requested.strip().lower()
        if normalized in {"", "default", "asr-local", "whisper-1"}:
            return self.settings.model
        available = {spec.id.lower(): spec.id for spec in self.settings.models}
        if normalized not in available:
            allowed = ", ".join(spec.id for spec in self.settings.models)
            raise ValueError(f"Unknown or disallowed faster-whisper model {requested!r}. Allowed: {allowed}")
        return available[normalized]

    def _model_spec(self, model_id: str):
        return next(spec for spec in self.settings.models if spec.id.lower() == model_id.lower())

    def _model_source(self, model_id: str) -> str:
        spec = self._model_spec(model_id)
        return str(spec.path) if spec.path and spec.path.is_dir() else model_id

    def _model_installed(self, model_id: str) -> bool:
        spec = self._model_spec(model_id)
        if spec.path:
            return spec.path.is_dir() and any(spec.path.iterdir())
        cache_name = "models--" + spec.source.replace("/", "--")
        return (self.settings.model_root / cache_name).is_dir()

    def _release_model(self) -> None:
        self._model = None
        self._loaded_device = ""
        self._loaded_model_id = ""
        gc.collect()
