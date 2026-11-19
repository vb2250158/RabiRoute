"""Bindings for the pinned Sherpa ONNX wheel's absolute keyword timestamps."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

_ABI_STRUCTS = (
    "OnlineTransducerModelConfig", "OnlineParaformerModelConfig",
    "OnlineZipformer2CtcModelConfig", "OnlineNemoCtcModelConfig",
    "OnlineToneCtcModelConfig", "OnlineModelConfig", "FeatureConfig",
    "KeywordSpotterConfig", "KeywordResult",
)
_ABI_FUNCTIONS = (
    "GetVersionStr", "CreateKeywordSpotter", "DestroyKeywordSpotter", "CreateKeywordStream",
    "DestroyOnlineStream", "OnlineStreamAcceptWaveform", "IsKeywordStreamReady",
    "DecodeKeywordStream", "GetKeywordResult", "DestroyKeywordResult",
)


@lru_cache(maxsize=1)
def _binding():
    from cffi import FFI
    import sherpa_onnx

    package = Path(sherpa_onnx.__file__).parent
    header = (package / "include" / "sherpa-onnx" / "c-api" / "c-api.h").read_text(encoding="utf-8")
    header = re.sub(r"/\*.*?\*/", "", header, flags=re.DOTALL)
    declarations = [
        "typedef struct SherpaOnnxKeywordSpotter SherpaOnnxKeywordSpotter;",
        "typedef struct SherpaOnnxOnlineStream SherpaOnnxOnlineStream;",
    ]
    for suffix in _ABI_STRUCTS:
        name = "SherpaOnnx" + suffix
        match = re.search(r"typedef struct " + name + r"\s*\{[^}]*\}\s*" + name + ";", header)
        if match is None:
            raise RuntimeError("ASSISTANT_WAKE_NATIVE_ABI_UNAVAILABLE")
        declarations.append(match[0])
    for suffix in _ABI_FUNCTIONS:
        match = re.search(
            r"^SHERPA_ONNX_API\s+([\w\s*]+?\bSherpaOnnx" + suffix + r"\([^;]*?\);)",
            header, flags=re.MULTILINE,
        )
        if match is None:
            raise RuntimeError("ASSISTANT_WAKE_NATIVE_ABI_UNAVAILABLE")
        declarations.append(match[1])
    ffi = FFI()
    ffi.cdef("\n".join(declarations))
    libraries = (
        "sherpa-onnx-c-api.dll", "libsherpa-onnx-c-api.so", "libsherpa-onnx-c-api.dylib",
    )
    path = next((package / "lib" / file for file in libraries if (package / "lib" / file).is_file()), None)
    if path is None:
        raise RuntimeError("ASSISTANT_WAKE_NATIVE_LIBRARY_MISSING")
    library = ffi.dlopen(str(path))
    if ffi.string(library.SherpaOnnxGetVersionStr()) != b"2.0.2":
        raise RuntimeError("ASSISTANT_WAKE_NATIVE_ABI_UNAVAILABLE")
    return ffi, library


@dataclass(frozen=True)
class TimedKeyword:
    alias_index: int
    first_token_seconds: float
    last_token_seconds: float


class SherpaWake:
    def __init__(self, tokens: str, encoder: str, decoder: str, joiner: str, keywords: str):
        ffi, library = self._ffi, self._library = _binding()
        config = ffi.new("SherpaOnnxKeywordSpotterConfig *")
        config.feat_config.sample_rate = 16000
        config.feat_config.feature_dim = 80
        model = config.model_config
        token_path, encoder_path, decoder_path, joiner_path, provider = [
            ffi.new("char[]", os.fsencode(value)) for value in (tokens, encoder, decoder, joiner, "cpu")
        ]
        model.tokens, model.num_threads, model.provider = token_path, 1, provider
        model.transducer.encoder, model.transducer.decoder, model.transducer.joiner = encoder_path, decoder_path, joiner_path
        config.max_active_paths, config.num_trailing_blanks = 4, 1
        config.keywords_score, config.keywords_threshold = 1.0, 0.25
        words = keywords.replace("/", "\n").encode("utf-8")
        backing = ffi.new("char[]", words)
        config.keywords_buf, config.keywords_buf_size = backing, len(words)
        spotter = library.SherpaOnnxCreateKeywordSpotter(config)
        if spotter == ffi.NULL:
            raise RuntimeError("ASSISTANT_WAKE_NATIVE_LOAD_FAILED")
        self._spotter = ffi.gc(spotter, library.SherpaOnnxDestroyKeywordSpotter)

    def create_stream(self):
        stream = self._library.SherpaOnnxCreateKeywordStream(self._spotter)
        if stream == self._ffi.NULL:
            raise RuntimeError("ASSISTANT_WAKE_NATIVE_STREAM_FAILED")
        return self._ffi.gc(stream, self._library.SherpaOnnxDestroyOnlineStream)

    def accept(self, stream, sample_rate: int, samples: np.ndarray) -> None:
        pcm = self._ffi.from_buffer("float[]", samples)
        self._library.SherpaOnnxOnlineStreamAcceptWaveform(stream, sample_rate, pcm, len(samples))

    def detect(self, stream) -> TimedKeyword | None:
        library = self._library
        while library.SherpaOnnxIsKeywordStreamReady(self._spotter, stream):
            library.SherpaOnnxDecodeKeywordStream(self._spotter, stream)
            result = library.SherpaOnnxGetKeywordResult(self._spotter, stream)
            if result == self._ffi.NULL:
                continue
            try:
                if result.count < 1 or result.timestamps == self._ffi.NULL or result.keyword == self._ffi.NULL:
                    continue
                keyword = self._ffi.string(result.keyword).decode("ascii")
                if not keyword.startswith("rabi-"):
                    continue
                hit = TimedKeyword(
                    int(keyword.removeprefix("rabi-")),
                    float(result.start_time + result.timestamps[0]),
                    float(result.start_time + result.timestamps[result.count - 1]),
                )
                return hit
            finally:
                library.SherpaOnnxDestroyKeywordResult(result)
        return None
