from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any


LANGUAGE_TAGS = {
    "chinese": "ZH",
    "zh": "ZH",
    "zh-cn": "ZH",
    "简体中文": "ZH",
    "中文": "ZH",
    "japanese": "JA",
    "ja": "JA",
    "日本語": "JA",
    "日语": "JA",
    "english": "EN",
    "en": "EN",
    "英语": "EN",
}
SUPPORTED_CLEANERS = {"cjke_cleaners2"}
TAG_PATTERN = re.compile(r"\[(ZH|JA|EN|KO)\]", re.IGNORECASE)


class FrontendError(ValueError):
    """Raised when text cannot be converted into model token ids."""


class FrontendDependencyError(RuntimeError):
    """Raised when an optional language frontend dependency is missing."""


def infer_language_tag(text: str) -> str:
    if any("\u3040" <= char <= "\u30ff" for char in text):
        return "JA"
    if any("\u4e00" <= char <= "\u9fff" for char in text):
        return "ZH"
    return "EN"


def wrap_language(text: str, language: str | None) -> str:
    if TAG_PATTERN.search(text):
        return text
    key = str(language or "").strip().lower()
    tag = LANGUAGE_TAGS.get(key) or infer_language_tag(text)
    return f"[{tag}]{text}[{tag}]"


def cjke_cleaners2(text: str) -> str:
    """Convert tagged Chinese, Japanese, or English text into the model IPA alphabet.

    The language-specific conversion follows the Apache-2.0 text frontend from
    Plachtaa/VITS-fast-fine-tuning. Imports stay lazy so a Chinese-only worker
    does not require the Japanese or English dependencies at startup.
    """

    def chinese(match: re.Match[str]) -> str:
        from rabispeech.onnx_vits.text.mandarin import chinese_to_ipa

        return chinese_to_ipa(match.group(1)) + " "

    def japanese(match: re.Match[str]) -> str:
        from rabispeech.onnx_vits.text.japanese import japanese_to_ipa2

        return japanese_to_ipa2(match.group(1)) + " "

    def english(match: re.Match[str]) -> str:
        from rabispeech.onnx_vits.text.english import english_to_ipa2

        return english_to_ipa2(match.group(1)) + " "

    if re.search(r"\[KO\].*?\[KO\]", text, flags=re.IGNORECASE | re.DOTALL):
        raise FrontendError("This ONNX-VITS frontend supports Chinese, Japanese, and English, not Korean.")
    text = re.sub(r"\[ZH\](.*?)\[ZH\]", chinese, text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"\[JA\](.*?)\[JA\]", japanese, text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"\[EN\](.*?)\[EN\]", english, text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"\s+$", "", text)
    return re.sub(r"([^\.,!\?\-…~])$", r"\1.", text)


class CjkeTextFrontend:
    def __init__(
        self,
        symbols: list[str],
        *,
        cleaner_names: list[str] | None = None,
        add_blank: bool = True,
        cleaner: Callable[[str], str] | None = None,
    ) -> None:
        if not symbols:
            raise FrontendError("Model config must define a non-empty symbols list.")
        names = cleaner_names or ["cjke_cleaners2"]
        unsupported = [name for name in names if name not in SUPPORTED_CLEANERS]
        if unsupported:
            raise FrontendError(f"Unsupported text cleaner(s): {', '.join(unsupported)}")
        self.symbols = list(symbols)
        self.symbol_to_id = {symbol: index for index, symbol in enumerate(self.symbols)}
        self.cleaner_names = list(names)
        self.add_blank = bool(add_blank)
        self.cleaner = cleaner or cjke_cleaners2

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> CjkeTextFrontend:
        data = config.get("data") if isinstance(config.get("data"), dict) else {}
        return cls(
            [str(symbol) for symbol in config.get("symbols", [])],
            cleaner_names=[str(name) for name in data.get("text_cleaners", ["cjke_cleaners2"])],
            add_blank=bool(data.get("add_blank", True)),
        )

    def token_ids(self, text: str, language: str | None = None) -> list[int]:
        tagged = wrap_language(text.strip(), language)
        try:
            cleaned = self.cleaner(tagged)
        except ModuleNotFoundError as exc:
            package = exc.name or "an optional frontend package"
            raise FrontendDependencyError(
                f"Missing {package}; install the RabiSpeech ONNX-VITS dependencies."
            ) from exc
        ids = [self.symbol_to_id[symbol] for symbol in cleaned if symbol in self.symbol_to_id]
        if not ids:
            raise FrontendError("Text frontend produced no symbols supported by this model bundle.")
        if not self.add_blank:
            return ids
        interspersed = [0] * (len(ids) * 2 + 1)
        interspersed[1::2] = ids
        return interspersed
