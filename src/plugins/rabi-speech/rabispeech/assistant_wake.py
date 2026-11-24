"""CPU keyword spotting on the resident microphone's sample timeline."""

from __future__ import annotations

import math
import re
from collections import deque
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from unicodedata import normalize

import numpy as np

from .sherpa_wake import SherpaWake

WAKE_MODEL = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
MODEL_FILES = {
    "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx": "2ca84d6bfe73e1ea3c9c49f600f7cad1c9ddd423c53c906b8bfe802444dd78d5",
    "decoder-epoch-13-avg-2-chunk-8-left-64.onnx": "63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21",
    "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx": "190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1",
    "tokens.txt": "2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0",
    "en.phone": "f7000ec3a90544c0c7c16090d8951779c2b322e14dad5006290f498567d439ea",
}
_WORDS = re.compile(r"[一-鿿]+|[A-Za-z]+(?:'[A-Za-z]+)*")
_PRE_ROLL_SECONDS = 0.95
_ACTIVE_QUIET_SECONDS = 0.95
_KEYWORD_TAIL_SECONDS = 0.04


@dataclass(frozen=True)
class WakeDetection:
    alias_index: int
    utterance_start_sample: int
    observed_through_sample: int
    keyword_start_sample: int
    replay_from_sample: int


def _model_paths(directory: Path) -> dict[str, str]:
    paths = {}
    for name, expected in MODEL_FILES.items():
        path = directory / name
        if not path.is_file():
            raise RuntimeError("ASSISTANT_WAKE_MODEL_MISSING")
        with path.open("rb") as data:
            digest = sha256()
            for chunk in iter(lambda: data.read(262_144), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError("ASSISTANT_WAKE_MODEL_INVALID")
        paths[name] = str(path)
    return paths


def _encode_aliases(aliases: list[str], lexicon: str, tokens: str) -> str:
    from pypinyin import pinyin
    from pypinyin.contrib.tone_convert import to_finals_tone, to_initials

    with Path(lexicon).open(encoding="utf-8") as source:
        phones = dict(line.rstrip().split(maxsplit=1) for line in source if line.strip())
    with Path(tokens).open(encoding="utf-8") as source:
        valid_tokens = {line.split()[0] for line in source if line.strip()}
    entries = []
    heard: set[tuple[str, ...]] = set()
    for index, alias in enumerate(aliases):
        phrase = normalize("NFKC", alias).strip()
        words = _WORDS.findall(phrase)
        if not words or "".join(words) != "".join(phrase.split()):
            raise ValueError(f"ASSISTANT_WAKE_ALIAS_UNSUPPORTED:{index}")
        encoded = []
        for word in words:
            if word.isascii():
                encoded.extend(phones.get(word.upper(), "").split())
                if word.upper() not in phones:
                    raise ValueError(f"ASSISTANT_WAKE_ALIAS_UNSUPPORTED:{index}")
            else:
                for (syllable,) in pinyin(word):
                    initial = to_initials(syllable, strict=False)
                    final = to_finals_tone(syllable, strict=False)
                    encoded.extend(part for part in (initial, final) if part)
        signature = tuple(encoded)
        if not signature or not all(token in valid_tokens for token in signature):
            raise ValueError(f"ASSISTANT_WAKE_ALIAS_UNSUPPORTED:{index}")
        if signature in heard:
            raise ValueError(f"ASSISTANT_WAKE_ALIAS_AMBIGUOUS:{index}")
        heard.add(signature)
        entries.append(" ".join(encoded) + f" @rabi-{index}")
    return "/".join(entries)


def assistant_keyword_profile(directory: Path, aliases: list[str]) -> dict[str, str]:
    paths = _model_paths(directory)
    return {
        "model": WAKE_MODEL,
        "keywords": _encode_aliases(aliases, paths["en.phone"], paths["tokens.txt"]),
        "tokensSha256": MODEL_FILES["tokens.txt"],
    }


class AssistantWakeSpotter:
    def __init__(self, model_directory: Path, aliases: list[str], sample_rate: int, start_sample: int = 0):
        paths = _model_paths(model_directory)
        keywords = _encode_aliases(aliases, paths["en.phone"], paths["tokens.txt"])
        encoder, decoder, joiner = (paths[name] for name in tuple(MODEL_FILES)[:3])
        self._spotter = SherpaWake(paths["tokens.txt"], encoder, decoder, joiner, keywords)
        self._sample_rate = sample_rate
        self._pre_roll_samples = round(sample_rate * _PRE_ROLL_SECONDS)
        self._position = start_sample
        self._stream = None
        self._waiting_for_quiet = False
        self._quiet_samples = 0
        self._utterance_start = start_sample
        self._stream_origin = start_sample
        self._pre: deque[np.ndarray] = deque()
        self._pre_size = 0

    def feed(self, pcm: bytes, threshold: float) -> WakeDetection | None:
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if not len(samples):
            return None
        frame_position = self._position
        self._position += len(samples)
        voiced = math.sqrt(float(np.mean(samples * samples))) >= threshold
        if self._waiting_for_quiet:
            self._quiet_samples = 0 if voiced else self._quiet_samples + len(samples)
            if self._quiet_samples >= self._sample_rate * 0.65:
                self._waiting_for_quiet = False
                self._quiet_samples = 0
            return None
        if self._stream is None:
            if not voiced:
                self._pre.append(samples)
                self._pre_size += len(samples)
                while self._pre_size > self._pre_roll_samples:
                    first_frame = self._pre.popleft()
                    discard = min(len(first_frame), self._pre_size - self._pre_roll_samples)
                    self._pre_size -= discard
                    if discard < len(first_frame):
                        self._pre.appendleft(first_frame[discard:].copy())
                return None
            self._utterance_start = frame_position
            self._stream_origin = frame_position - self._pre_size
            self._stream = self._spotter.create_stream()
            for previous in self._pre:
                self._spotter.accept(self._stream, self._sample_rate, previous)
            self._pre.clear()
            self._pre_size = 0
        self._quiet_samples = 0 if voiced else self._quiet_samples + len(samples)
        self._spotter.accept(self._stream, self._sample_rate, samples)
        hit = self._spotter.detect(self._stream)
        if hit is not None:
            first = self._stream_origin + round(hit.first_token_seconds * self._sample_rate)
            last = self._stream_origin + round(hit.last_token_seconds * self._sample_rate)
            self._stream = None
            self._waiting_for_quiet = True
            if self._stream_origin <= first <= last < self._position <= last + self._sample_rate:
                # The last token timestamp points into the keyword. Skip its first
                # 40 ms while keeping any audio not yet observed available to replay.
                replay = min(last + round(self._sample_rate * _KEYWORD_TAIL_SECONDS), self._position - 1)
                return WakeDetection(hit.alias_index, min(first, self._utterance_start), self._position, first, replay)
        if self._quiet_samples >= self._sample_rate * _ACTIVE_QUIET_SECONDS:
            self._stream = None
            self._quiet_samples = 0
        return None
