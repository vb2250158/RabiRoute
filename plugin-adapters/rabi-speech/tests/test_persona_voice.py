from __future__ import annotations

import json
import wave
from pathlib import Path

import pytest

from rabispeech.persona_voice import PersonaVoiceResolver


def wav(path: Path, seconds: float = 0.4) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * int(16000 * seconds))
    return path


def test_persona_voice_cache_is_owned_by_persona(tmp_path: Path) -> None:
    voice_dir = tmp_path / "roles" / "Rabi" / "voice"
    first = wav(voice_dir / "audio" / "gentle.wav")
    second = wav(voice_dir / "audio" / "bright.wav")
    (voice_dir / "voice-index.json").write_text(json.dumps([
        {"id": "gentle", "audio_file": "audio/gentle.wav", "emotion_tags": ["gentle"]},
        {"id": "bright", "audio_file": "audio/bright.wav", "emotion_tags": ["bright"]},
    ]), encoding="utf-8")
    resolver = PersonaVoiceResolver(tmp_path / "roles", tmp_path / "fallback", first, min_prompt_duration=1, target_prompt_duration=1)

    owner = resolver.resolve_persona_voice_dir("rabi")
    selected = resolver.resolve_prompt_files(text="晚上好", persona_voice_dir=owner, emotion_tags=["gentle"])
    prepared, sources, augmented = resolver.prepare_prompt_audio(selected, owner)

    assert owner == voice_dir.resolve()
    assert augmented is True
    assert set(sources) == {first.resolve(), second.resolve()}
    assert prepared.is_relative_to(voice_dir / "cache" / "reference-audio")


def test_persona_folder_cannot_escape_roles_root(tmp_path: Path) -> None:
    default = wav(tmp_path / "default.wav")
    resolver = PersonaVoiceResolver(tmp_path / "roles", tmp_path / "fallback", default)
    with pytest.raises(ValueError):
        resolver.resolve_persona_voice_dir(persona_folder=tmp_path)


def test_persona_without_voice_directory_uses_worker_default(tmp_path: Path) -> None:
    default = wav(tmp_path / "default.wav")
    (tmp_path / "roles" / "Rabi").mkdir(parents=True)
    resolver = PersonaVoiceResolver(tmp_path / "roles", tmp_path / "fallback", default)
    assert resolver.resolve_persona_voice_dir("Rabi") is None
    assert resolver.resolve_prompt_files(text="你好") == [default.resolve()]


def test_reference_text_matches_selected_audio_order(tmp_path: Path) -> None:
    voice_dir = tmp_path / "roles" / "Rabi" / "voice"
    first = wav(voice_dir / "audio" / "first.wav")
    second = wav(voice_dir / "audio" / "second.wav")
    (voice_dir / "voice-index.json").write_text(json.dumps({"entries": [
        {"audio_file": "audio/first.wav", "text": "第一句。"},
        {"audio_file": "audio/second.wav", "text": "第二句。"}
    ]}, ensure_ascii=False), encoding="utf-8")
    resolver = PersonaVoiceResolver(tmp_path / "roles", tmp_path / "fallback", first)
    assert resolver.reference_text(voice_dir.resolve(), [second.resolve(), first.resolve()]) == "第二句。 第一句。"


def test_engine_options_are_scoped_to_persona_and_engine(tmp_path: Path) -> None:
    voice_dir = tmp_path / "roles" / "Ilias" / "voice"
    default = wav(voice_dir / "audio" / "reference.wav")
    (voice_dir / "voice-profile.json").write_text(json.dumps({
        "engine_options": {
            "qwen3-tts": {"clone_mode": "x_vector_only"},
            "gpt-sovits": {"temperature": 0.8},
        }
    }), encoding="utf-8")
    resolver = PersonaVoiceResolver(tmp_path / "roles", tmp_path / "fallback", default)

    assert resolver.engine_options(voice_dir.resolve(), "qwen3-tts") == {"clone_mode": "x_vector_only"}
    assert resolver.engine_options(voice_dir.resolve(), "unknown") == {}
    assert resolver.engine_options(None, "qwen3-tts") == {}
