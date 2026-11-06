from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from rabispeech.config import load_settings
from rabispeech.contracts import TranscriptionRequest
from rabispeech.providers.faster_whisper import FasterWhisperProvider


def test_cuda_inference_failure_retries_once_on_cpu(tmp_path: Path) -> None:
    settings = load_settings(Path(__file__).parents[1] / "config.example.json").faster_whisper
    provider = FasterWhisperProvider(settings)
    cuda_model = object()
    cpu_model = object()
    provider._model = cuda_model
    provider._loaded_device = "cuda"
    provider._loaded_model_id = settings.model
    provider._ensure_model = lambda _model_id: cuda_model  # type: ignore[method-assign]

    def load_model(device: str, model_id: str) -> object:
        assert device == "cpu"
        assert model_id == settings.model
        provider._model = cpu_model
        provider._loaded_device = "cpu"
        provider._loaded_model_id = model_id
        return cpu_model

    def run_model(model: object, _request: TranscriptionRequest, _vad_filter: bool | None = None):
        if model is cuda_model:
            raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
        segment = SimpleNamespace(text="fallback ok", start=0.0, end=0.2, words=[])
        info = SimpleNamespace(language="en", duration=0.2)
        return [segment], info

    provider._load_model = load_model  # type: ignore[method-assign]
    provider._run_model = run_model  # type: ignore[method-assign]
    result = provider._transcribe_sync(TranscriptionRequest(audio_path=tmp_path / "unused.wav"))

    assert provider._loaded_device == "cpu"
    assert result.text == "fallback ok"


def test_model_catalog_rejects_uninstalled_or_unknown_models() -> None:
    settings = load_settings(Path(__file__).parents[1] / "config.example.json").faster_whisper
    provider = FasterWhisperProvider(settings)
    assert {item["id"] for item in provider.capabilities()["models"]} == {"tiny", "small", "large-v3-turbo"}
    try:
        provider._resolve_model("made-up")
    except ValueError as exc:
        assert "Allowed" in str(exc)
    else:
        raise AssertionError("Unknown model should be rejected")
