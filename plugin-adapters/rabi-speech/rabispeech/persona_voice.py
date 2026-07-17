from __future__ import annotations

import hashlib
import html
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Callable


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _tags(value: object) -> set[str]:
    if isinstance(value, str):
        return {item for item in re.split(r"[,，\s]+", value.lower()) if item}
    if isinstance(value, list):
        return {str(item).strip().lower() for item in value if str(item).strip()}
    return set()


def _vector(value: object) -> list[float]:
    if isinstance(value, str):
        value = [item.strip() for item in value.split(",") if item.strip()]
    if not isinstance(value, list):
        return []
    try:
        return [float(item) for item in value]
    except (TypeError, ValueError):
        return []


def _duration(path: Path) -> float:
    import soundfile as sf

    return float(sf.info(str(path)).duration)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _score(text: str, entry: dict[str, Any], emotion_tags: object, emotion_vector: object, patterns: object) -> float:
    score = 0.0
    lowered = text.lower()
    for key in ("text", "title", "translation_zh", "zh", "ja"):
        sample = str(entry.get(key) or "").strip().lower()
        if sample and (sample in lowered or lowered in sample):
            score += 100.0
    requested_tags = _tags(emotion_tags)
    entry_tags = _tags(entry.get("emotion_tags")) | _tags(entry.get("mood"))
    score += 50.0 * len(requested_tags & entry_tags)
    requested_vector = _vector(emotion_vector)
    entry_vector = _vector(entry.get("emotion_vector"))
    if requested_vector and entry_vector:
        size = min(len(requested_vector), len(entry_vector))
        distance = math.sqrt(sum((requested_vector[i] - entry_vector[i]) ** 2 for i in range(size)))
        score += max(0.0, 100.0 - distance * 180.0)
    all_patterns = list(entry.get("match_patterns") or [])
    if isinstance(patterns, list):
        all_patterns.extend(patterns)
    for pattern in all_patterns:
        try:
            if re.search(str(pattern), text, re.IGNORECASE):
                score += 140.0
        except re.error:
            if str(pattern).lower() in lowered:
                score += 70.0
    return score


class PersonaVoiceResolver:
    """Resolve immutable local voice snapshots owned by a Rabi persona directory."""

    def __init__(
        self,
        roles_root: str | Path,
        fallback_cache_dir: str | Path,
        default_prompt_audio: str | Path,
        *,
        min_prompt_duration: float = 6.0,
        target_prompt_duration: float = 10.0,
        max_prompt_duration: float | None = None,
        prompt_gap_seconds: float = 0.12,
        composite_target_sr: int | None = None,
        prepare_single_audio: Callable[[Path], Path] | None = None,
    ) -> None:
        self.roles_root = Path(roles_root).expanduser().resolve()
        self.fallback_cache_dir = Path(fallback_cache_dir).expanduser().resolve()
        self.default_prompt_audio = Path(default_prompt_audio).expanduser().resolve()
        self.min_prompt_duration = float(min_prompt_duration)
        self.target_prompt_duration = float(target_prompt_duration)
        self.max_prompt_duration = float(max_prompt_duration) if max_prompt_duration is not None else None
        self.prompt_gap_seconds = float(prompt_gap_seconds)
        self.composite_target_sr = composite_target_sr
        self.prepare_single_audio = prepare_single_audio
        self.roles_root.mkdir(parents=True, exist_ok=True)
        self.fallback_cache_dir.mkdir(parents=True, exist_ok=True)
        if not self.default_prompt_audio.is_file():
            raise FileNotFoundError(f"Default prompt audio does not exist: {self.default_prompt_audio}")

    def resolve_persona_voice_dir(self, persona_id: object = None, persona_folder: object = None) -> Path | None:
        if persona_folder:
            candidate = Path(str(persona_folder)).expanduser().resolve()
            if not candidate.is_relative_to(self.roles_root):
                raise ValueError("Persona voice folder must stay inside the configured roles root.")
            voice_dir = candidate if candidate.name.lower() == "voice" else candidate / "voice"
            if not voice_dir.is_dir():
                raise FileNotFoundError(f"Persona voice folder not found: {voice_dir}")
            return voice_dir
        requested = str(persona_id or "").strip()
        if not requested:
            return None
        if not re.fullmatch(r"[\w.\-\u3400-\u9fff]+", requested, re.UNICODE):
            raise ValueError("Persona id contains unsupported path characters.")
        role_dir = next((item for item in self.roles_root.iterdir() if item.is_dir() and item.name.lower() == requested.lower()), None)
        if role_dir is None:
            raise ValueError(f"Rabi persona not found: {requested}")
        voice_dir = role_dir / "voice"
        if not voice_dir.is_dir():
            return None
        return voice_dir.resolve()

    def resolve_prompt_files(
        self,
        *,
        prompt_audio: object = None,
        prompt_audios: object = None,
        text: str = "",
        persona_voice_dir: Path | None = None,
        emotion_tags: object = None,
        emotion_vector: object = None,
        match_patterns: object = None,
    ) -> list[Path]:
        raw: list[object] = []
        if prompt_audios:
            if not isinstance(prompt_audios, list):
                raise ValueError("prompt_audios must be a list.")
            raw.extend(prompt_audios)
        if prompt_audio:
            raw.append(prompt_audio)
        if not raw and persona_voice_dir:
            return self._select_persona_prompts(persona_voice_dir, text, emotion_tags, emotion_vector, match_patterns)
        if not raw:
            return [self.default_prompt_audio]
        allowed_root = persona_voice_dir or self.default_prompt_audio.parent
        resolved: list[Path] = []
        for value in raw:
            candidate = Path(str(value)).expanduser()
            if not candidate.is_absolute():
                candidate = allowed_root / candidate
            candidate = candidate.resolve()
            if persona_voice_dir and not candidate.is_relative_to(persona_voice_dir):
                raise ValueError("Persona prompt audio must stay inside its persona voice directory.")
            if not candidate.is_file():
                raise FileNotFoundError(f"Prompt audio not found: {candidate}")
            if candidate not in resolved:
                resolved.append(candidate)
        return resolved

    def prepare_prompt_audio(self, prompt_files: list[Path], persona_voice_dir: Path | None = None) -> tuple[Path, list[Path], bool]:
        files = list(prompt_files)
        if len(files) == 1 and _duration(files[0]) < self.min_prompt_duration and persona_voice_dir:
            for candidate in self._all_index_audio(persona_voice_dir):
                if candidate not in files:
                    next_total = sum(_duration(item) + self.prompt_gap_seconds for item in files) + _duration(candidate)
                    if self.max_prompt_duration is not None and next_total > self.max_prompt_duration:
                        continue
                    files.append(candidate)
                if sum(_duration(item) + self.prompt_gap_seconds for item in files) >= self.target_prompt_duration:
                    break
        if len(files) == 1:
            duration = _duration(files[0])
            if self.max_prompt_duration is not None and duration > self.max_prompt_duration:
                raise ValueError(f"Reference audio exceeds {self.max_prompt_duration:g} seconds: {files[0]}")
            prepared = self.prepare_single_audio(files[0]) if self.prepare_single_audio else files[0]
            return prepared, files, False
        cache_dir = (persona_voice_dir / "cache" / "reference-audio") if persona_voice_dir else self.fallback_cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "files": [{"path": str(path.relative_to(persona_voice_dir)) if persona_voice_dir else path.name, "sha256": _sha256(path)} for path in files],
            "gap": self.prompt_gap_seconds,
            "target_sr": self.composite_target_sr,
        }
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
        output = cache_dir / f"prompt-{digest}.wav"
        if not output.exists():
            self._concatenate(files, output)
        metadata = {"output": output.name, "sources": payload["files"], "rebuildable": True, "settings": payload}
        (cache_dir / f"prompt-{digest}.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return output, files, True

    def reference_text(self, persona_voice_dir: Path | None, prompt_files: list[Path]) -> str:
        """Return transcripts that match the selected reference files, in playback order."""
        if persona_voice_dir is None:
            return ""
        transcripts: dict[Path, str] = {}
        for entry in self._entries(persona_voice_dir):
            audio = self._entry_audio(persona_voice_dir, entry)
            if audio is None:
                continue
            text = next(
                (
                    str(entry.get(key) or "").strip()
                    for key in ("text", "transcript", "ja", "zh", "translation_zh")
                    if str(entry.get(key) or "").strip()
                ),
                "",
            )
            if text:
                text = html.unescape(re.sub(r"<br\s*/?>", "。", text, flags=re.IGNORECASE))
                text = re.sub(r"<[^>]+>", "", text).strip()
                transcripts[audio.resolve()] = text
        return " ".join(transcripts[path.resolve()] for path in prompt_files if path.resolve() in transcripts)

    def _entries(self, voice_dir: Path) -> list[dict[str, Any]]:
        index = voice_dir / "voice-index.json"
        if not index.is_file():
            raise FileNotFoundError(f"Persona voice index not found: {index}")
        value = _json(index)
        rows = value.get("entries", []) if isinstance(value, dict) else value
        return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []

    def _entry_audio(self, voice_dir: Path, entry: dict[str, Any]) -> Path | None:
        raw = str(entry.get("audio_file") or "").strip()
        if not raw:
            return None
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            candidate = voice_dir / candidate
        candidate = candidate.resolve()
        if not candidate.is_relative_to(voice_dir):
            return None
        return candidate if candidate.is_file() else None

    def _all_index_audio(self, voice_dir: Path) -> list[Path]:
        return [audio for entry in self._entries(voice_dir) if (audio := self._entry_audio(voice_dir, entry)) is not None]

    def _select_persona_prompts(self, voice_dir: Path, text: str, emotion_tags: object, emotion_vector: object, patterns: object) -> list[Path]:
        ranked: list[tuple[float, int, Path]] = []
        for position, entry in enumerate(self._entries(voice_dir)):
            audio = self._entry_audio(voice_dir, entry)
            if audio:
                duration = _duration(audio)
                if self.max_prompt_duration is None or duration <= self.max_prompt_duration:
                    ranked.append((_score(text, entry, emotion_tags, emotion_vector, patterns) + min(duration, 8.0), -position, audio))
        if not ranked:
            raise ValueError(f"Persona voice index contains no readable audio: {voice_dir}")
        ranked.sort(reverse=True)
        selected: list[Path] = []
        total = 0.0
        for _, _, audio in ranked:
            next_total = total + _duration(audio) + self.prompt_gap_seconds
            if selected and self.max_prompt_duration is not None and next_total > self.max_prompt_duration:
                continue
            selected.append(audio)
            total = next_total
            if total >= self.target_prompt_duration:
                break
        return selected

    def _concatenate(self, files: list[Path], output: Path) -> None:
        import numpy as np
        import soundfile as sf

        chunks: list[Any] = []
        sample_rate = self.composite_target_sr
        for source in files:
            data, source_rate = sf.read(str(source), dtype="float32", always_2d=True)
            mono = data.mean(axis=1)
            sample_rate = sample_rate or int(source_rate)
            if source_rate != sample_rate:
                old = np.linspace(0.0, 1.0, num=len(mono), endpoint=False)
                size = max(1, int(round(len(mono) * sample_rate / source_rate)))
                mono = np.interp(np.linspace(0.0, 1.0, num=size, endpoint=False), old, mono).astype("float32")
            chunks.extend([mono, np.zeros(int(sample_rate * self.prompt_gap_seconds), dtype="float32")])
        output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output), np.concatenate(chunks), int(sample_rate), subtype="PCM_16")
