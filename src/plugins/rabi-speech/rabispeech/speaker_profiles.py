from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from .contracts import TranscriptSegment, TranscriptionResult


REGISTRY_VERSION = 2
MAX_DISPLAY_NAME_LENGTH = 100
MAX_ALIAS_COUNT = 32
MAX_ALIAS_LENGTH = 100
MAX_SESSION_ID_LENGTH = 200
MAX_RECORD_ID_LENGTH = 200
MAX_SPEAKER_LABEL_LENGTH = 200
MAX_ARCHIVED_REGISTRIES = 50

SPEAKER_DECISION_MANUAL_SESSION_BINDING = "manual_session_binding"
SPEAKER_DECISION_MANUAL_RECORD_BINDING = "manual_record_binding"
SPEAKER_DECISION_UNBOUND_LABEL = "unbound_diarization_label"
SPEAKER_DECISION_NOT_LABELED = "not_labeled"


class SpeakerRegistryNotFoundError(KeyError):
    pass


class SpeakerRegistryStorageError(RuntimeError):
    pass


class SpeakerRegistryConflictError(RuntimeError):
    pass


class SpeakerProfileRegistry:
    """Local profile metadata and explicit record/diarization-label bindings.

    A diarization label such as ``Speaker 1`` is only a provider label inside a
    single ASR task. New bindings are record-scoped, and legacy session-scoped
    bindings are readable only through the legacy interface. This registry
    never treats a provider label as a biometric identity.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve()
        self.archive_root = self.path.parent / f"{self.path.stem}-archive"
        self._lock = threading.RLock()
        self._profiles: dict[str, dict[str, object]] = {}
        self._bindings: dict[tuple[str, str | None, str], dict[str, object]] = {}
        self._load_error: str | None = None
        self._load()

    @staticmethod
    def capabilities() -> dict[str, object]:
        return {
            "scope": "loopback-only",
            "mode": "manual_record_label_binding",
            "manual_binding": True,
            "binding_scope": "record_speaker_label",
            "legacy_session_bindings_readable": True,
            "aliases_are_metadata_only": True,
            "diarization_labels_are_biometric_identity": False,
            "stores_raw_enrollment_audio": False,
            "voiceprint": {
                "supported": False,
                "experimental": False,
                "reason": "No validated speaker-embedding and matcher dependency is installed.",
            },
        }

    def snapshot(self, *, session_id: str | None = None) -> dict[str, object]:
        normalized_session = _optional_text(session_id, MAX_SESSION_ID_LENGTH)
        with self._lock:
            profiles = [dict(value) for value in self._profiles.values()]
            bindings = [
                self._public_binding(value)
                for value in self._bindings.values()
                if not normalized_session or value["session_id"] == normalized_session
            ]
            profiles.sort(key=lambda value: (str(value["display_name"]).casefold(), str(value["id"])))
            bindings.sort(
                key=lambda value: (
                    str(value["session_id"]).casefold(),
                    str(value.get("record_id") or "").casefold(),
                    str(value["speaker_label"]).casefold(),
                )
            )
            return {
                "object": "rabispeech.speaker_registry",
                "profiles": profiles,
                "bindings": bindings,
                "capability": {
                    **self.capabilities(),
                    **({"storage_error": self._load_error} if self._load_error else {}),
                },
            }

    def profile_names(self) -> dict[str, str]:
        with self._lock:
            return {profile_id: str(value["display_name"]) for profile_id, value in self._profiles.items()}

    def create_profile(self, display_name: str, aliases: object = None) -> dict[str, object]:
        normalized_name = _required_text(display_name, "display_name", MAX_DISPLAY_NAME_LENGTH)
        normalized_aliases = _aliases(aliases, normalized_name)
        now = time.time()
        profile = {
            "id": f"speaker-{uuid.uuid4().hex}",
            "display_name": normalized_name,
            "aliases": normalized_aliases,
            "created_at": now,
            "updated_at": now,
        }
        with self._lock:
            self._ensure_writable()
            self._profiles[str(profile["id"])] = profile
            try:
                self._persist()
            except Exception:
                del self._profiles[str(profile["id"])]
                raise
        return dict(profile)

    def update_profile(
        self,
        profile_id: str,
        *,
        display_name: str | None = None,
        aliases: object = None,
        aliases_provided: bool = False,
    ) -> dict[str, object]:
        normalized_id = _required_text(profile_id, "speaker_id", 100)
        with self._lock:
            self._ensure_writable()
            current = self._profiles.get(normalized_id)
            if current is None:
                raise SpeakerRegistryNotFoundError(f"Unknown speaker profile: {normalized_id}")
            if display_name is None and not aliases_provided:
                raise ValueError("At least one of display_name or aliases is required.")
            normalized_name = (
                _required_text(display_name, "display_name", MAX_DISPLAY_NAME_LENGTH)
                if display_name is not None
                else str(current["display_name"])
            )
            normalized_aliases = (
                _aliases(aliases, normalized_name)
                if aliases_provided
                else _aliases(current.get("aliases"), normalized_name)
            )
            updated = {
                **current,
                "display_name": normalized_name,
                "aliases": normalized_aliases,
                "updated_at": time.time(),
            }
            self._profiles[normalized_id] = updated
            try:
                self._persist()
            except Exception:
                self._profiles[normalized_id] = current
                raise
            return dict(updated)

    def delete_profile(self, profile_id: str) -> dict[str, object]:
        normalized_id = _required_text(profile_id, "speaker_id", 100)
        with self._lock:
            self._ensure_writable()
            profile = self._profiles.pop(normalized_id, None)
            if profile is None:
                raise SpeakerRegistryNotFoundError(f"Unknown speaker profile: {normalized_id}")
            removed_keys = [key for key, value in self._bindings.items() if value["speaker_id"] == normalized_id]
            removed_bindings = {key: self._bindings[key] for key in removed_keys}
            for key in removed_keys:
                del self._bindings[key]
            try:
                self._persist()
            except Exception:
                self._profiles[normalized_id] = profile
                self._bindings.update(removed_bindings)
                raise
            return {"deleted": dict(profile), "removed_bindings": len(removed_keys)}

    def bind(
        self,
        session_id: str,
        speaker_label: str,
        speaker_id: str,
        *,
        record_id: str | None = None,
    ) -> dict[str, object]:
        normalized_session = _required_text(session_id, "session_id", MAX_SESSION_ID_LENGTH)
        normalized_record = _optional_text(record_id, MAX_RECORD_ID_LENGTH)
        normalized_label = _required_text(speaker_label, "speaker_label", MAX_SPEAKER_LABEL_LENGTH)
        normalized_id = _required_text(speaker_id, "speaker_id", 100)
        with self._lock:
            self._ensure_writable()
            if normalized_id not in self._profiles:
                raise SpeakerRegistryNotFoundError(f"Unknown speaker profile: {normalized_id}")
            key = _binding_key(normalized_session, normalized_label, normalized_record)
            existing = self._bindings.get(key)
            now = time.time()
            binding = {
                "session_id": normalized_session,
                "record_id": normalized_record,
                "speaker_label": normalized_label,
                "speaker_id": normalized_id,
                "decision": (
                    SPEAKER_DECISION_MANUAL_RECORD_BINDING
                    if normalized_record
                    else SPEAKER_DECISION_MANUAL_SESSION_BINDING
                ),
                "created_at": float(existing.get("created_at") or now) if existing else now,
                "updated_at": now,
            }
            self._bindings[key] = binding
            try:
                self._persist()
            except Exception:
                if existing is None:
                    del self._bindings[key]
                else:
                    self._bindings[key] = existing
                raise
            return self._public_binding(binding)

    def identify_and_bind(
        self,
        session_id: str,
        speaker_label: str,
        *,
        record_id: str | None = None,
        speaker_id: str | None = None,
        display_name: str | None = None,
        aliases: object = None,
    ) -> dict[str, object]:
        """Idempotently resolve or create one person and bind a session label.

        This is an Agent-friendly metadata operation, not a biometric match. The
        entire profile lookup/create/update plus binding change is persisted as
        one registry transaction.
        """

        normalized_session = _required_text(session_id, "session_id", MAX_SESSION_ID_LENGTH)
        normalized_record = _optional_text(record_id, MAX_RECORD_ID_LENGTH)
        normalized_label = _required_text(speaker_label, "speaker_label", MAX_SPEAKER_LABEL_LENGTH)
        normalized_id = _optional_text(speaker_id, 100)
        normalized_name = _optional_text(display_name, MAX_DISPLAY_NAME_LENGTH)
        normalized_aliases = _aliases(aliases, normalized_name or "")
        if normalized_id is None and normalized_name is None:
            raise ValueError("display_name is required when speaker_id is not provided.")

        with self._lock:
            self._ensure_writable()
            created = False
            matched_by = "speaker_id" if normalized_id else "display_name_or_alias"
            if normalized_id:
                current = self._profiles.get(normalized_id)
                if current is None:
                    raise SpeakerRegistryNotFoundError(f"Unknown speaker profile: {normalized_id}")
            else:
                identity_keys = {
                    value.casefold()
                    for value in [normalized_name, *normalized_aliases]
                    if value
                }
                matches = [
                    profile
                    for profile in self._profiles.values()
                    if identity_keys.intersection(_profile_identity_keys(profile))
                ]
                if len(matches) > 1:
                    raise SpeakerRegistryConflictError(
                        "Speaker identity is ambiguous; provide an explicit speaker_id."
                    )
                current = matches[0] if matches else None
                if current is None:
                    now = time.time()
                    normalized_id = f"speaker-{uuid.uuid4().hex}"
                    current = {
                        "id": normalized_id,
                        "display_name": normalized_name,
                        "aliases": normalized_aliases,
                        "created_at": now,
                        "updated_at": now,
                    }
                    created = True
                    matched_by = "created"

            profile_id = str(current["id"])
            incoming_aliases = list(normalized_aliases)
            if normalized_name and normalized_name.casefold() != str(current["display_name"]).casefold():
                incoming_aliases.insert(0, normalized_name)
            merged_aliases = _aliases(
                [*list(current.get("aliases") or []), *incoming_aliases],
                str(current["display_name"]),
            )
            profile_changed = created or merged_aliases != list(current.get("aliases") or [])
            profile = {
                **current,
                "aliases": merged_aliases,
                "updated_at": time.time() if profile_changed else current["updated_at"],
            }

            key = _binding_key(normalized_session, normalized_label, normalized_record)
            previous_binding = self._bindings.get(key)
            binding_changed = previous_binding is None or previous_binding["speaker_id"] != profile_id
            now = time.time()
            binding = {
                "session_id": normalized_session,
                "record_id": normalized_record,
                "speaker_label": normalized_label,
                "speaker_id": profile_id,
                "decision": (
                    SPEAKER_DECISION_MANUAL_RECORD_BINDING
                    if normalized_record
                    else SPEAKER_DECISION_MANUAL_SESSION_BINDING
                ),
                "created_at": (
                    float(previous_binding.get("created_at") or now)
                    if previous_binding
                    else now
                ),
                "updated_at": now if binding_changed else previous_binding["updated_at"],
            }

            if profile_changed or binding_changed:
                previous_profile = self._profiles.get(profile_id)
                self._profiles[profile_id] = profile
                self._bindings[key] = binding
                try:
                    self._persist()
                except Exception:
                    if previous_profile is None:
                        del self._profiles[profile_id]
                    else:
                        self._profiles[profile_id] = previous_profile
                    if previous_binding is None:
                        del self._bindings[key]
                    else:
                        self._bindings[key] = previous_binding
                    raise

            return {
                "object": "rabispeech.speaker_identity",
                "created": created,
                "reused": not created,
                "profile_updated": profile_changed and not created,
                "binding_changed": binding_changed,
                "matched_by": matched_by,
                "profile": dict(profile),
                "binding": self._public_binding(binding),
            }

    def unbind(
        self,
        session_id: str,
        speaker_label: str,
        *,
        record_id: str | None = None,
    ) -> dict[str, object]:
        normalized_session = _required_text(session_id, "session_id", MAX_SESSION_ID_LENGTH)
        normalized_record = _optional_text(record_id, MAX_RECORD_ID_LENGTH)
        normalized_label = _required_text(speaker_label, "speaker_label", MAX_SPEAKER_LABEL_LENGTH)
        with self._lock:
            self._ensure_writable()
            key = _binding_key(normalized_session, normalized_label, normalized_record)
            binding = self._bindings.pop(key, None)
            if binding is None:
                raise SpeakerRegistryNotFoundError(
                    f"No speaker binding for session {normalized_session!r}, "
                    f"record {normalized_record!r}, and label {normalized_label!r}."
                )
            try:
                self._persist()
            except Exception:
                self._bindings[key] = binding
                raise
            return self._public_binding(binding)

    def resolve(
        self,
        session_id: str | None,
        speaker_label: str | None,
        *,
        record_id: str | None = None,
    ) -> dict[str, object | None]:
        label = _optional_text(speaker_label, MAX_SPEAKER_LABEL_LENGTH)
        if not label:
            return {
                "speaker_label": None,
                "speaker_id": None,
                "speaker_name": None,
                "speaker_decision": SPEAKER_DECISION_NOT_LABELED,
            }
        normalized_session = _optional_text(session_id, MAX_SESSION_ID_LENGTH)
        if not normalized_session:
            return {
                "speaker_label": label,
                "speaker_id": None,
                "speaker_name": None,
                "speaker_decision": SPEAKER_DECISION_UNBOUND_LABEL,
            }
        normalized_record = _optional_text(record_id, MAX_RECORD_ID_LENGTH)
        with self._lock:
            binding = self._bindings.get(_binding_key(normalized_session, label, normalized_record))
            profile = self._profiles.get(str(binding["speaker_id"])) if binding else None
            if not binding or not profile:
                return {
                    "speaker_label": label,
                    "speaker_id": None,
                    "speaker_name": None,
                    "speaker_decision": SPEAKER_DECISION_UNBOUND_LABEL,
                }
            return {
                "speaker_label": label,
                "speaker_id": str(profile["id"]),
                "speaker_name": str(profile["display_name"]),
                "speaker_decision": str(binding["decision"]),
            }

    def resolve_transcription(
        self,
        result: TranscriptionResult,
        *,
        session_id: str | None,
        record_id: str | None = None,
    ) -> TranscriptionResult:
        segments: list[TranscriptSegment] = []
        for segment in result.segments:
            original_label = segment.speaker_label or segment.speaker
            resolution = self.resolve(session_id, original_label, record_id=record_id)
            manually_resolved = bool(resolution["speaker_id"])
            segments.append(
                replace(
                    segment,
                    speaker=segment.speaker or original_label,
                    speaker_label=resolution["speaker_label"],
                    speaker_id=resolution["speaker_id"] if manually_resolved else segment.speaker_id,
                    speaker_name=resolution["speaker_name"] if manually_resolved else segment.speaker_name,
                    speaker_decision=(
                        str(resolution["speaker_decision"])
                        if manually_resolved
                        else segment.speaker_decision or str(resolution["speaker_decision"])
                    ),
                )
            )
        return replace(result, segments=segments)

    def _public_binding(self, binding: dict[str, object]) -> dict[str, object]:
        profile = self._profiles.get(str(binding["speaker_id"]))
        return {
            **binding,
            "speaker_name": str(profile["display_name"]) if profile else None,
        }

    def _load(self) -> None:
        if not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("registry root must be an object")
            for value in raw.get("profiles") or []:
                if not isinstance(value, dict):
                    continue
                profile_id = _required_text(value.get("id"), "speaker_id", 100)
                display_name = _required_text(value.get("display_name"), "display_name", MAX_DISPLAY_NAME_LENGTH)
                self._profiles[profile_id] = {
                    "id": profile_id,
                    "display_name": display_name,
                    "aliases": _aliases(value.get("aliases"), display_name),
                    "created_at": _timestamp(value.get("created_at")),
                    "updated_at": _timestamp(value.get("updated_at")),
                }
            for value in raw.get("bindings") or []:
                if not isinstance(value, dict):
                    continue
                session_id = _required_text(value.get("session_id"), "session_id", MAX_SESSION_ID_LENGTH)
                record_id = _optional_text(value.get("record_id"), MAX_RECORD_ID_LENGTH)
                speaker_label = _required_text(value.get("speaker_label"), "speaker_label", MAX_SPEAKER_LABEL_LENGTH)
                speaker_id = _required_text(value.get("speaker_id"), "speaker_id", 100)
                if speaker_id not in self._profiles:
                    continue
                binding = {
                    "session_id": session_id,
                    "record_id": record_id,
                    "speaker_label": speaker_label,
                    "speaker_id": speaker_id,
                    "decision": (
                        SPEAKER_DECISION_MANUAL_RECORD_BINDING
                        if record_id
                        else SPEAKER_DECISION_MANUAL_SESSION_BINDING
                    ),
                    "created_at": _timestamp(value.get("created_at")),
                    "updated_at": _timestamp(value.get("updated_at")),
                }
                self._bindings[_binding_key(session_id, speaker_label, record_id)] = binding
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self._profiles.clear()
            self._bindings.clear()
            self._load_error = f"{type(exc).__name__}: {exc}"[:500]

    def _ensure_writable(self) -> None:
        if self._load_error:
            raise SpeakerRegistryStorageError(
                "Speaker registry is unreadable; repair or move the local registry before changing speaker profiles."
            )

    def _persist(self) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.is_file():
                self.archive_root.mkdir(parents=True, exist_ok=True)
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
                shutil.copy2(self.path, self.archive_root / f"{self.path.stem}-{stamp}.json")
                archives = sorted(self.archive_root.glob(f"{self.path.stem}-*.json"), reverse=True)
                for stale in archives[MAX_ARCHIVED_REGISTRIES:]:
                    stale.unlink(missing_ok=True)
            payload = {
                "version": REGISTRY_VERSION,
                "updated_at": time.time(),
                "profiles": list(self._profiles.values()),
                "bindings": list(self._bindings.values()),
            }
            with temporary.open("w", encoding="utf-8", newline="\n") as output:
                json.dump(payload, output, ensure_ascii=False, indent=2)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except OSError as exc:
            raise SpeakerRegistryStorageError(f"Speaker registry write failed: {exc}") from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _binding_key(
    session_id: str,
    speaker_label: str,
    record_id: str | None = None,
) -> tuple[str, str | None, str]:
    return session_id, record_id, speaker_label.casefold()


def _profile_identity_keys(profile: dict[str, object]) -> set[str]:
    return {
        value.casefold()
        for value in [str(profile.get("display_name") or ""), *list(profile.get("aliases") or [])]
        if value
    }


def _required_text(value: object, field: str, maximum: int) -> str:
    normalized = _optional_text(value, maximum)
    if not normalized:
        raise ValueError(f"{field} is required.")
    return normalized


def _optional_text(value: object, maximum: int) -> str | None:
    if value is None:
        return None
    normalized = " ".join(str(value).strip().split())
    if not normalized:
        return None
    if len(normalized) > maximum:
        raise ValueError(f"Text exceeds {maximum} characters.")
    return normalized


def _aliases(value: object, display_name: str) -> list[str]:
    if value is None:
        rows: list[object] = []
    elif isinstance(value, list):
        rows = value
    else:
        raise ValueError("aliases must be an array of strings.")
    if len(rows) > MAX_ALIAS_COUNT:
        raise ValueError(f"aliases cannot contain more than {MAX_ALIAS_COUNT} values.")
    aliases: list[str] = []
    seen = {display_name.casefold()}
    for value in rows:
        alias = _required_text(value, "alias", MAX_ALIAS_LENGTH)
        key = alias.casefold()
        if key in seen:
            continue
        seen.add(key)
        aliases.append(alias)
    return aliases


def _timestamp(value: object) -> float:
    parsed = float(value or time.time())
    return parsed if parsed > 0 else time.time()
