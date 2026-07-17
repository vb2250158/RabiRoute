"""Local-only TTS/ASR gateway used by the RabiLink speech proxy."""

from .app import create_app

__all__ = ["create_app"]
