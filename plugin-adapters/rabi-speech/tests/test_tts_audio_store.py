from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from rabispeech.tts_audio_store import TtsAudioStore, TtsAudioStoreRegistry


def test_tts_audio_store_retains_files_and_cleans_them_after_24_hours(tmp_path) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"RIFF-test")
    store = TtsAudioStore(tmp_path / "tts-audio", retention_minutes=1440)

    retained = store.retain(source)

    assert retained.is_file()
    assert retained.read_bytes() == source.read_bytes()
    assert store.relative_path(retained) == retained.name
    assert store.retention_seconds == 24 * 60 * 60

    expired_at = time.time() - store.retention_seconds - 1
    os.utime(retained, (expired_at, expired_at))
    assert store.cleanup() == [retained]
    assert not retained.exists()


def test_tts_audio_store_uses_fennenote_slider_bounds(tmp_path) -> None:
    assert TtsAudioStore(tmp_path / "minimum", retention_minutes=0).retention_minutes == 1
    assert TtsAudioStore(tmp_path / "maximum", retention_minutes=9999).retention_minutes == 1440


def test_tts_audio_store_rejects_paths_outside_its_cache_root(tmp_path) -> None:
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"RIFF-outside")
    store = TtsAudioStore(tmp_path / "tts-audio")

    with pytest.raises(ValueError, match="cache root"):
        store.relative_path(outside)
    with pytest.raises(ValueError, match="cache root"):
        store.expires_at(outside)


def test_tts_audio_store_registry_cleans_every_registered_cache(tmp_path) -> None:
    registry = TtsAudioStoreRegistry(retention_minutes=60)
    first = registry.get(tmp_path / "first")
    second = registry.get(tmp_path / "second")
    first_file = first.root / "first.wav"
    second_file = second.root / "second.wav"
    first_file.write_bytes(b"RIFF-first")
    second_file.write_bytes(b"RIFF-second")
    expired = time.time() - first.retention_seconds - 1
    os.utime(first_file, (expired, expired))
    os.utime(second_file, (expired, expired))

    assert set(registry.cleanup()) == {first_file, second_file}
    assert registry.get(first.root) is first


def test_registered_root_identity_mismatch_fails_closed_without_rebinding_registry(tmp_path, monkeypatch) -> None:
    root = tmp_path / "tts-audio"
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "keep.wav"
    sentinel.write_bytes(b"RIFF-keep")
    source = tmp_path / "source.wav"
    source.write_bytes(b"RIFF-source")
    registry = TtsAudioStoreRegistry()
    store = registry.get(root)
    owned = store.root / "owned.wav"
    owned.write_bytes(b"RIFF-owned")
    outside_canonical = outside.resolve()
    real_resolve = Path.resolve

    def redirected_resolve(path: Path, strict: bool = False) -> Path:
        if path == store.root:
            return outside_canonical
        return real_resolve(path, strict=strict)

    monkeypatch.setattr(Path, "resolve", redirected_resolve)

    assert registry.get(root) is store
    for operation in (
        lambda: store.retain(source),
        store.cleanup,
        lambda: store.expires_at(owned),
        lambda: store.relative_path(owned),
    ):
        with pytest.raises(RuntimeError, match="identity changed"):
            operation()
    assert list(outside.iterdir()) == [sentinel]


def test_registry_cleanup_continues_after_one_root_identity_failure(tmp_path, monkeypatch) -> None:
    registry = TtsAudioStoreRegistry(retention_minutes=60)
    bad = registry.get(tmp_path / "bad")
    good = registry.get(tmp_path / "good")
    good_file = good.root / "expired.wav"
    good_file.write_bytes(b"RIFF-expired")
    expired = time.time() - good.retention_seconds - 1
    os.utime(good_file, (expired, expired))
    redirected = (tmp_path / "redirected").resolve()
    real_resolve = Path.resolve

    def redirected_resolve(path: Path, strict: bool = False) -> Path:
        if path == bad.root:
            return redirected
        return real_resolve(path, strict=strict)

    monkeypatch.setattr(Path, "resolve", redirected_resolve)

    with pytest.raises(RuntimeError, match="1 registered cache root"):
        registry.cleanup()
    assert not good_file.exists()


def test_cleanup_skips_candidate_that_resolves_outside_canonical_root(tmp_path, monkeypatch) -> None:
    store = TtsAudioStore(tmp_path / "tts-audio")
    candidate = store.root / "candidate.wav"
    candidate.write_bytes(b"RIFF-candidate")
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"RIFF-outside")
    outside_canonical = outside.resolve()
    real_resolve = Path.resolve

    def redirected_resolve(path: Path, strict: bool = False) -> Path:
        if path == candidate:
            return outside_canonical
        return real_resolve(path, strict=strict)

    monkeypatch.setattr(Path, "resolve", redirected_resolve)

    assert store.cleanup(now=time.time() + store.retention_seconds + 1) == []
    assert candidate.exists()
    assert outside.read_bytes() == b"RIFF-outside"


def test_cleanup_skips_file_symlink_without_deleting_external_target(tmp_path) -> None:
    store = TtsAudioStore(tmp_path / "tts-audio")
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"RIFF-outside")
    link = store.root / "linked.wav"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("File symlinks are unavailable on this Windows host.")

    assert store.cleanup(now=time.time() + store.retention_seconds + 1) == []
    assert link.is_symlink()
    assert outside.read_bytes() == b"RIFF-outside"


def test_replaced_root_symlink_cannot_redirect_writes_or_cleanup(tmp_path) -> None:
    root = tmp_path / "tts-audio"
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "keep.wav"
    sentinel.write_bytes(b"RIFF-keep")
    source = tmp_path / "source.wav"
    source.write_bytes(b"RIFF-source")
    registry = TtsAudioStoreRegistry()
    store = registry.get(root)
    backup = tmp_path / "original-cache"
    root.rename(backup)
    try:
        root.symlink_to(outside, target_is_directory=True)
    except OSError:
        backup.rename(root)
        pytest.skip("Directory symlinks are unavailable on this Windows host.")

    try:
        assert registry.get(root) is store
        with pytest.raises(RuntimeError, match="ordinary directory|identity changed"):
            store.retain(source)
        with pytest.raises(RuntimeError, match="ordinary directory|identity changed"):
            store.cleanup(now=time.time() + store.retention_seconds + 1)
        assert list(outside.iterdir()) == [sentinel]
    finally:
        root.unlink(missing_ok=True)
        backup.rename(root)
