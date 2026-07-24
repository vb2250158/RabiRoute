from __future__ import annotations

import os
import shutil
import stat
import threading
import time
import uuid
from pathlib import Path


def _logical_path(value: str | Path) -> Path:
    return Path(os.path.abspath(Path(value).expanduser()))


class TtsAudioStore:
    """Retain finalized TTS responses for a bounded, rebuildable local window."""

    def __init__(self, root: str | Path, retention_minutes: float = 1440.0) -> None:
        self.root = _logical_path(root)
        self.retention_minutes = max(1.0, min(1440.0, float(retention_minutes)))
        self.root.mkdir(parents=True, exist_ok=True)
        self.canonical_root = self._initial_canonical_root()
        self._lock = threading.Lock()
        self.cleanup()

    @property
    def retention_seconds(self) -> float:
        return self.retention_minutes * 60.0

    def retain(self, source: str | Path) -> Path:
        source_path = Path(source).expanduser().resolve()
        if not source_path.is_file():
            raise FileNotFoundError(f"TTS audio does not exist: {source_path}")
        suffix = source_path.suffix.lower() or ".wav"
        with self._lock:
            root = self._validated_root()
            target = root / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}{suffix}"
            shutil.copyfile(source_path, target)
            self._validated_root()
            self._cleanup_locked(time.time())
        return target

    def cleanup(self, now: float | None = None) -> list[Path]:
        with self._lock:
            return self._cleanup_locked(time.time() if now is None else float(now))

    def expires_at(self, path: str | Path) -> float:
        with self._lock:
            return self._owned_file_locked(path).stat().st_mtime + self.retention_seconds

    def relative_path(self, path: str | Path) -> str:
        with self._lock:
            return self._owned_file_locked(path).relative_to(self.canonical_root).as_posix()

    def next_expiry(self) -> float | None:
        with self._lock:
            root = self._validated_root()
            earliest: float | None = None
            try:
                paths = list(root.iterdir())
            except OSError as exc:
                raise RuntimeError("TTS audio cache root cannot be listed.") from exc
            for path in paths:
                if path.is_symlink():
                    continue
                try:
                    candidate = path.resolve(strict=True)
                    if candidate.parent != root or not candidate.is_file():
                        continue
                    expires_at = candidate.stat().st_mtime + self.retention_seconds
                except OSError:
                    continue
                if earliest is None or expires_at < earliest:
                    earliest = expires_at
            return earliest

    def _initial_canonical_root(self) -> Path:
        try:
            mode = os.lstat(self.root).st_mode
            canonical = self.root.resolve(strict=True)
        except OSError as exc:
            raise RuntimeError("TTS audio cache root is unavailable.") from exc
        if not stat.S_ISDIR(mode) or not canonical.is_dir():
            raise RuntimeError("TTS audio cache root must be an ordinary directory.")
        return canonical

    def _validated_root(self) -> Path:
        try:
            mode = os.lstat(self.root).st_mode
            current = self.root.resolve(strict=True)
        except OSError as exc:
            raise RuntimeError("TTS audio cache root is unavailable.") from exc
        if not stat.S_ISDIR(mode) or not current.is_dir():
            raise RuntimeError("TTS audio cache root must remain an ordinary directory.")
        if current != self.canonical_root:
            raise RuntimeError("TTS audio cache root identity changed after registration.")
        return current

    def _owned_file_locked(self, path: str | Path) -> Path:
        root = self._validated_root()
        logical = _logical_path(path)
        if logical.is_symlink():
            raise ValueError("TTS audio path must not be a symbolic link.")
        try:
            candidate = logical.resolve(strict=True)
        except OSError as exc:
            raise FileNotFoundError(f"TTS audio does not exist: {logical}") from exc
        if not candidate.is_relative_to(root):
            raise ValueError("TTS audio path must stay inside its cache root.")
        if not candidate.is_file():
            raise FileNotFoundError(f"TTS audio does not exist: {candidate}")
        return candidate

    def _cleanup_locked(self, now: float) -> list[Path]:
        cutoff = now - self.retention_seconds
        removed: list[Path] = []
        root = self._validated_root()
        try:
            paths = list(root.iterdir())
        except OSError as exc:
            raise RuntimeError("TTS audio cache root cannot be listed.") from exc
        for path in paths:
            self._validated_root()
            if path.is_symlink():
                continue
            try:
                candidate = path.resolve(strict=True)
            except OSError:
                continue
            if candidate.parent != root or not candidate.is_file():
                continue
            try:
                if candidate.stat().st_mtime > cutoff:
                    continue
                self._validated_root()
                if path.is_symlink() or path.resolve(strict=True) != candidate:
                    continue
                path.unlink()
                removed.append(candidate)
            except OSError:
                continue
        return removed


class TtsAudioStoreRegistry:
    """Own all active TTS cache stores so one lifecycle task can clean them."""

    def __init__(self, retention_minutes: float = 1440.0) -> None:
        self.retention_minutes = retention_minutes
        self._stores: dict[Path, TtsAudioStore] = {}
        self._lock = threading.Lock()

    def get(self, root: str | Path) -> TtsAudioStore:
        logical = _logical_path(root)
        with self._lock:
            store = self._stores.get(logical)
            if store is None:
                store = TtsAudioStore(logical, self.retention_minutes)
                self._stores[logical] = store
            return store

    def cleanup(self, now: float | None = None) -> list[Path]:
        with self._lock:
            stores = tuple(self._stores.values())
        removed: list[Path] = []
        errors: list[RuntimeError] = []
        for store in stores:
            try:
                removed.extend(store.cleanup(now))
            except RuntimeError as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError(f"TTS cleanup failed for {len(errors)} registered cache root(s).") from errors[0]
        return removed

    def next_expiry(self) -> float | None:
        with self._lock:
            stores = tuple(self._stores.values())
        earliest: float | None = None
        errors: list[RuntimeError] = []
        for store in stores:
            try:
                expires_at = store.next_expiry()
            except RuntimeError as exc:
                errors.append(exc)
                continue
            if expires_at is not None and (earliest is None or expires_at < earliest):
                earliest = expires_at
        if errors:
            raise RuntimeError(f"TTS expiry scan failed for {len(errors)} registered cache root(s).") from errors[0]
        return earliest
