"""Read the Manager-provided timeout snapshot; values are milliseconds on the wire."""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache

@lru_cache(maxsize=1)
def _snapshot(raw: str) -> dict[str, int]:
    try:
        values = json.loads(raw or "{}")
    except (TypeError, ValueError):
        logging.getLogger(__name__).warning("RABIROUTE_TIMEOUT_OVERRIDES is not valid JSON; using default timeouts. Fix or remove that environment setting.")
        return {}
    if not isinstance(values, dict):
        logging.getLogger(__name__).warning("RABIROUTE_TIMEOUT_OVERRIDES must be an object; using default timeouts.")
        return {}
    accepted = {}
    invalid = []
    for key, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 1 <= value <= 2147483647 or value != int(value):
            invalid.append(key)
        else:
            accepted[key] = int(value)
    if invalid:
        logging.getLogger(__name__).warning("Ignoring %s invalid RABIROUTE_TIMEOUT_OVERRIDES entries (%s); valid entries remain active. Use integer milliseconds from 1 to 2147483647.", len(invalid), ", ".join(invalid[:5]))
    return accepted

_current = None

def configure_timeouts(values: object) -> None:
    global _current
    _current = None if values is None else _snapshot(json.dumps(values))

def get_timeout_ms(key: str, fallback: int) -> int:
    return int(get_timeout_seconds(key, fallback / 1000) * 1000)

def get_timeout_seconds(key: str, fallback: float) -> float:
    value = (_current if _current is not None else _snapshot(os.environ.get("RABIROUTE_TIMEOUT_OVERRIDES", "{}"))).get(key)
    return float(fallback) if value is None else value / 1000.0
