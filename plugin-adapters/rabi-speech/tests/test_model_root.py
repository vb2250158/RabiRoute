from __future__ import annotations

import json
import sys
import types
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "rabispeech"
package = types.ModuleType("rabispeech")
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules.setdefault("rabispeech", package)

from rabispeech.config import load_settings


def test_explicit_model_root_rebases_builtin_weight_paths(tmp_path, monkeypatch) -> None:
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
                "providers": {
                    "tts": {"local_tts": {"models": []}},
                    "asr": {
                        "faster_whisper": {
                            "models": [
                                {
                                    "id": "large-v3-turbo",
                                    "path": "../../../models/rabispeech/asr/faster-whisper-large-v3-turbo",
                                }
                            ]
                        }
                    },
                },
                "speaker_recognition": {
                    "model_path": "../../../models/rabispeech/speaker/3dspeaker.onnx"
                },
            }
        ),
        encoding="utf-8",
    )
    model_root = tmp_path / "private-models" / "rabispeech"
    monkeypatch.setenv("RABISPEECH_MODEL_ROOT", str(model_root))

    settings = load_settings(config)

    assert settings.faster_whisper.model_root == model_root / "asr" / "faster-whisper-cache"
    large = next(model for model in settings.faster_whisper.models if model.id == "large-v3-turbo")
    assert large.path == model_root / "asr" / "faster-whisper-large-v3-turbo"
    assert settings.speaker_recognition.model_path == model_root / "speaker" / "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"
