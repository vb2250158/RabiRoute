from __future__ import annotations

import re


_LATIN_TO_BOPOMOFO = [
    (re.compile(source, re.IGNORECASE), target)
    for source, target in [
        ("a", "ㄟˉ"),
        ("b", "ㄅㄧˋ"),
        ("c", "ㄙㄧˉ"),
        ("d", "ㄉㄧˋ"),
        ("e", "ㄧˋ"),
        ("f", "ㄝˊㄈㄨˋ"),
        ("g", "ㄐㄧˋ"),
        ("h", "ㄝˇㄑㄩˋ"),
        ("i", "ㄞˋ"),
        ("j", "ㄐㄟˋ"),
        ("k", "ㄎㄟˋ"),
        ("l", "ㄝˊㄛˋ"),
        ("m", "ㄝˊㄇㄨˋ"),
        ("n", "ㄣˉ"),
        ("o", "ㄡˉ"),
        ("p", "ㄆㄧˉ"),
        ("q", "ㄎㄧㄡˉ"),
        ("r", "ㄚˋ"),
        ("s", "ㄝˊㄙˋ"),
        ("t", "ㄊㄧˋ"),
        ("u", "ㄧㄡˉ"),
        ("v", "ㄨㄧˉ"),
        ("w", "ㄉㄚˋㄅㄨˋㄌㄧㄡˋ"),
        ("x", "ㄝˉㄎㄨˋㄙˋ"),
        ("y", "ㄨㄞˋ"),
        ("z", "ㄗㄟˋ"),
    ]
]

_BOPOMOFO_TO_IPA = [
    (re.compile(source), target)
    for source, target in [
        ("ㄅㄛ", "p⁼wo"),
        ("ㄆㄛ", "pʰwo"),
        ("ㄇㄛ", "mwo"),
        ("ㄈㄛ", "fwo"),
        ("ㄅ", "p⁼"),
        ("ㄆ", "pʰ"),
        ("ㄇ", "m"),
        ("ㄈ", "f"),
        ("ㄉ", "t⁼"),
        ("ㄊ", "tʰ"),
        ("ㄋ", "n"),
        ("ㄌ", "l"),
        ("ㄍ", "k⁼"),
        ("ㄎ", "kʰ"),
        ("ㄏ", "x"),
        ("ㄐ", "tʃ⁼"),
        ("ㄑ", "tʃʰ"),
        ("ㄒ", "ʃ"),
        ("ㄓ", "ts`⁼"),
        ("ㄔ", "ts`ʰ"),
        ("ㄕ", "s`"),
        ("ㄖ", "ɹ`"),
        ("ㄗ", "ts⁼"),
        ("ㄘ", "tsʰ"),
        ("ㄙ", "s"),
        ("ㄚ", "a"),
        ("ㄛ", "o"),
        ("ㄜ", "ə"),
        ("ㄝ", "ɛ"),
        ("ㄞ", "aɪ"),
        ("ㄟ", "eɪ"),
        ("ㄠ", "ɑʊ"),
        ("ㄡ", "oʊ"),
        ("ㄧㄢ", "jɛn"),
        ("ㄩㄢ", "ɥæn"),
        ("ㄢ", "an"),
        ("ㄧㄣ", "in"),
        ("ㄩㄣ", "ɥn"),
        ("ㄣ", "ən"),
        ("ㄤ", "ɑŋ"),
        ("ㄧㄥ", "iŋ"),
        ("ㄨㄥ", "ʊŋ"),
        ("ㄩㄥ", "jʊŋ"),
        ("ㄥ", "əŋ"),
        ("ㄦ", "əɻ"),
        ("ㄧ", "i"),
        ("ㄨ", "u"),
        ("ㄩ", "ɥ"),
        ("ˉ", "→"),
        ("ˊ", "↑"),
        ("ˇ", "↓↑"),
        ("ˋ", "↓"),
        ("˙", ""),
        ("，", ","),
        ("。", "."),
        ("！", "!"),
        ("？", "?"),
        ("—", "-"),
    ]
]


def number_to_chinese(text: str) -> str:
    import cn2an

    for number in re.findall(r"\d+(?:\.?\d+)?", text):
        text = text.replace(number, cn2an.an2cn(number), 1)
    return text


def chinese_to_bopomofo(text: str) -> str:
    from pypinyin import BOPOMOFO, lazy_pinyin

    text = text.replace("、", "，").replace("；", "，").replace("：", "，")
    result = ""
    # Processing contiguous Han segments directly keeps the frontend free of
    # jieba's legacy pkg_resources import, which is unreliable on UNC/NAS
    # workspaces. pypinyin still applies its phrase dictionaries to each span.
    for span in re.findall(r"[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+", text):
        if not re.search(r"[\u4e00-\u9fff]", span):
            result += span
            continue
        bopomofos = lazy_pinyin(span, BOPOMOFO)
        bopomofos = [re.sub(r"([\u3105-\u3129])$", r"\1ˉ", item) for item in bopomofos]
        if result and not result.endswith((" ", ",", ".", "!", "?", "-")):
            result += " "
        result += "".join(bopomofos)
    return result


def chinese_to_ipa(text: str) -> str:
    text = chinese_to_bopomofo(number_to_chinese(text))
    for regex, replacement in _LATIN_TO_BOPOMOFO:
        text = re.sub(regex, replacement, text)
    for regex, replacement in _BOPOMOFO_TO_IPA:
        text = re.sub(regex, replacement, text)
    text = re.sub(r"i([aoe])", r"j\1", text)
    text = re.sub(r"u([aoəe])", r"w\1", text)
    text = re.sub(r"([sɹ]`[⁼ʰ]?)([→↓↑ ]+|$)", r"\1ɹ`\2", text).replace("ɻ", "ɹ`")
    return re.sub(r"([s][⁼ʰ]?)([→↓↑ ]+|$)", r"\1ɹ\2", text)
