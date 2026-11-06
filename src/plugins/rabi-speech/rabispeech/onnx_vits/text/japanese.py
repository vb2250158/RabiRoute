from __future__ import annotations

import importlib
import importlib.util
import os
import re
import sys
import types
from pathlib import Path


_JAPANESE_CHARACTERS = re.compile(
    r"[A-Za-z\d\u3005\u3040-\u30ff\u4e00-\u9fff\uff11-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9d]"
)
_JAPANESE_MARKS = re.compile(
    r"[^A-Za-z\d\u3005\u3040-\u30ff\u4e00-\u9fff\uff11-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9d]"
)
_ROMAJI_TO_IPA2 = [
    (re.compile(source), target)
    for source, target in [
        ("u", "ɯ"),
        ("ʧ", "tʃ"),
        ("j", "dʑ"),
        ("y", "j"),
        ("ni", "n^i"),
        ("nj", "n^"),
        ("hi", "çi"),
        ("hj", "ç"),
        ("f", "ɸ"),
        ("I", "i*"),
        ("U", "ɯ*"),
        ("r", "ɾ"),
    ]
]
_REAL_SOKUON = [
    (re.compile(source), target)
    for source, target in [
        (r"Q([↑↓]*[kg])", r"k#\1"),
        (r"Q([↑↓]*[tdjʧ])", r"t#\1"),
        (r"Q([↑↓]*[sʃ])", r"s\1"),
        (r"Q([↑↓]*[pb])", r"p#\1"),
    ]
]
_REAL_HATSUON = [
    (re.compile(source), target)
    for source, target in [
        (r"N([↑↓]*[pbm])", r"m\1"),
        (r"N([↑↓]*[ʧʥj])", r"n^\1"),
        (r"N([↑↓]*[tdn])", r"n\1"),
        (r"N([↑↓]*[kg])", r"ŋ\1"),
    ]
]


def load_pyopenjtalk():
    """Import pyopenjtalk without pkg_resources scanning a NAS workspace."""

    if "pyopenjtalk" in sys.modules:
        return sys.modules["pyopenjtalk"]
    spec = importlib.util.find_spec("pyopenjtalk")
    if spec is None or not spec.submodule_search_locations:
        raise ModuleNotFoundError("pyopenjtalk")
    package_root = Path(next(iter(spec.submodule_search_locations))).resolve()
    dictionary = os.environ.get("OPEN_JTALK_DICT_DIR", "").strip()
    dictionary_path = Path(dictionary).expanduser().resolve() if dictionary else package_root / "open_jtalk_dic_utf_8-1.11"
    if not dictionary_path.is_dir():
        raise RuntimeError(
            "Japanese ONNX-VITS requires an existing local OpenJTalk dictionary. "
            "Set OPEN_JTALK_DICT_DIR; automatic runtime download is disabled."
        )
    os.environ["OPEN_JTALK_DICT_DIR"] = str(dictionary_path)

    previous = sys.modules.get("pkg_resources")
    shim = types.ModuleType("pkg_resources")
    shim.resource_filename = lambda _package, resource: str(package_root / resource)  # type: ignore[attr-defined]
    sys.modules["pkg_resources"] = shim
    try:
        return importlib.import_module("pyopenjtalk")
    finally:
        if previous is None:
            sys.modules.pop("pkg_resources", None)
        else:
            sys.modules["pkg_resources"] = previous


def japanese_to_romaji_with_accent(text: str) -> str:
    from unidecode import unidecode

    pyopenjtalk = load_pyopenjtalk()
    text = re.sub("％", "パーセント", text)
    sentences = re.split(_JAPANESE_MARKS, text)
    marks = re.findall(_JAPANESE_MARKS, text)
    result = ""
    for index, sentence in enumerate(sentences):
        if re.match(_JAPANESE_CHARACTERS, sentence):
            if result:
                result += " "
            labels = pyopenjtalk.extract_fullcontext(sentence)
            for label_index, label in enumerate(labels):
                phoneme = re.search(r"\-([^\+]*)\+", label).group(1)
                if phoneme in {"sil", "pau"}:
                    continue
                result += phoneme.replace("ch", "ʧ").replace("sh", "ʃ").replace("cl", "Q")
                a1 = int(re.search(r"/A:(\-?[0-9]+)\+", label).group(1))
                a2 = int(re.search(r"\+(\d+)\+", label).group(1))
                a3 = int(re.search(r"\+(\d+)/", label).group(1))
                next_phoneme = re.search(r"\-([^\+]*)\+", labels[label_index + 1]).group(1)
                a2_next = -1 if next_phoneme in {"sil", "pau"} else int(
                    re.search(r"\+(\d+)\+", labels[label_index + 1]).group(1)
                )
                if a3 == 1 and a2_next == 1:
                    result += " "
                elif a1 == 0 and a2_next == a2 + 1:
                    result += "↓"
                elif a2 == 1 and a2_next == 2:
                    result += "↑"
        if index < len(marks):
            result += unidecode(marks[index]).replace(" ", "")
    return result


def japanese_to_ipa2(text: str) -> str:
    text = japanese_to_romaji_with_accent(text).replace("...", "…")
    for regex, replacement in _REAL_SOKUON:
        text = re.sub(regex, replacement, text)
    for regex, replacement in _REAL_HATSUON:
        text = re.sub(regex, replacement, text)
    for regex, replacement in _ROMAJI_TO_IPA2:
        text = re.sub(regex, replacement, text)
    return text
