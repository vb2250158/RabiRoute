from __future__ import annotations

import re


_COMMA_NUMBER_RE = re.compile(r"([0-9][0-9,]+[0-9])")
_DECIMAL_NUMBER_RE = re.compile(r"([0-9]+\.[0-9]+)")
_POUNDS_RE = re.compile(r"£([0-9,]*[0-9]+)")
_DOLLARS_RE = re.compile(r"\$([0-9.,]*[0-9]+)")
_ORDINAL_RE = re.compile(r"[0-9]+(st|nd|rd|th)")
_NUMBER_RE = re.compile(r"[0-9]+")
_ABBREVIATIONS = [
    (re.compile(rf"\b{short}\.", re.IGNORECASE), full)
    for short, full in [
        ("mrs", "misess"),
        ("mr", "mister"),
        ("dr", "doctor"),
        ("st", "saint"),
        ("co", "company"),
        ("jr", "junior"),
        ("maj", "major"),
        ("gen", "general"),
        ("drs", "doctors"),
        ("rev", "reverend"),
        ("lt", "lieutenant"),
        ("hon", "honorable"),
        ("sgt", "sergeant"),
        ("capt", "captain"),
        ("esq", "esquire"),
        ("ltd", "limited"),
        ("col", "colonel"),
        ("ft", "fort"),
    ]
]
_IPA_TO_IPA2 = [(re.compile(source), target) for source, target in [("r", "ɹ"), ("ʤ", "dʒ"), ("ʧ", "tʃ")]]


def _inflect_engine():
    import inflect

    return inflect.engine()


def _expand_dollars(match: re.Match[str]) -> str:
    parts = match.group(1).split(".")
    if len(parts) > 2:
        return match.group(1) + " dollars"
    dollars = int(parts[0]) if parts[0] else 0
    cents = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    if dollars and cents:
        return f"{dollars} {'dollar' if dollars == 1 else 'dollars'}, {cents} {'cent' if cents == 1 else 'cents'}"
    if dollars:
        return f"{dollars} {'dollar' if dollars == 1 else 'dollars'}"
    if cents:
        return f"{cents} {'cent' if cents == 1 else 'cents'}"
    return "zero dollars"


def _expand_number(match: re.Match[str]) -> str:
    engine = _inflect_engine()
    number = int(match.group(0))
    if 1000 < number < 3000:
        if number == 2000:
            return "two thousand"
        if 2000 < number < 2010:
            return "two thousand " + engine.number_to_words(number % 100)
        if number % 100 == 0:
            return engine.number_to_words(number // 100) + " hundred"
        return engine.number_to_words(number, andword="", zero="oh", group=2).replace(", ", " ")
    return engine.number_to_words(number, andword="")


def normalize_numbers(text: str) -> str:
    engine = _inflect_engine()
    text = re.sub(_COMMA_NUMBER_RE, lambda match: match.group(1).replace(",", ""), text)
    text = re.sub(_POUNDS_RE, r"\1 pounds", text)
    text = re.sub(_DOLLARS_RE, _expand_dollars, text)
    text = re.sub(_DECIMAL_NUMBER_RE, lambda match: match.group(1).replace(".", " point "), text)
    text = re.sub(_ORDINAL_RE, lambda match: engine.number_to_words(match.group(0)), text)
    return re.sub(_NUMBER_RE, _expand_number, text)


def english_to_ipa2(text: str) -> str:
    import eng_to_ipa as ipa
    from unidecode import unidecode

    text = unidecode(text).lower()
    for regex, replacement in _ABBREVIATIONS:
        text = re.sub(regex, replacement, text)
    text = normalize_numbers(text)
    text = re.sub(r"\s+", " ", ipa.convert(text))
    text = re.sub(r"l([^aeiouæɑɔəɛɪʊ ]*(?: |$))", lambda match: "ɫ" + match.group(1), text)
    for regex, replacement in _IPA_TO_IPA2:
        text = re.sub(regex, replacement, text)
    return text.replace("...", "…")
