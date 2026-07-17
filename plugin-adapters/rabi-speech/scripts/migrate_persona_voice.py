from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path
from typing import Any


RUNTIME_ENTRY_KEYS = (
    "id",
    "title",
    "language",
    "text",
    "transcript",
    "text_zh",
    "text_ja",
    "text_ko",
    "voice_key",
    "base_name",
    "idx",
    "mood",
    "emotion_tags",
    "emotion_vector",
    "match_patterns",
    "style_notes",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import a legacy private voice character into one Rabi persona.")
    parser.add_argument("--legacy-root", required=True)
    parser.add_argument("--roles-root", required=True)
    parser.add_argument("--persona", required=True)
    parser.add_argument("--legacy-character", required=True)
    parser.add_argument("--default-model", default="local-tts/gpt-sovits")
    parser.add_argument("--execute", action="store_true", help="Copy private data. Without this flag, print a dry-run plan.")
    return parser.parse_args()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def safe_id(value: str) -> str:
    normalized = value.strip()
    if not normalized or any(mark in normalized for mark in ("/", "\\", "..")):
        raise ValueError("Persona and legacy character ids must be single directory names.")
    return normalized


def legacy_profile(legacy_root: Path, character_id: str) -> dict[str, Any]:
    index_path = legacy_root / "reference-index.json"
    if not index_path.is_file():
        return {}
    root = read_json(index_path)
    rows = root.get("characters", []) if isinstance(root, dict) else []
    return next((dict(row) for row in rows if isinstance(row, dict) and str(row.get("id") or "").lower() == character_id.lower()), {})


def source_audio_for_entry(source_dir: Path, character_id: str, entry: dict[str, Any]) -> tuple[Path, Path]:
    raw = str(entry.get("audio_file") or "").replace("\\", "/").strip()
    prefix = f"voice-references/characters/{character_id}/"
    relative = Path(raw[len(prefix):] if raw.lower().startswith(prefix.lower()) else raw)
    candidates = [source_dir / relative, source_dir / "audio" / relative.name]
    source = next((path.resolve() for path in candidates if path.is_file()), None)
    if source is None or not source.is_relative_to(source_dir.resolve()):
        raise FileNotFoundError(f"Indexed local audio is missing or outside the character folder: {raw}")
    audio_root = (source_dir / "audio").resolve()
    if not source.is_relative_to(audio_root):
        raise ValueError(f"Indexed runtime audio must be under the legacy audio folder: {source}")
    return source, source.relative_to(audio_root)


def main() -> int:
    args = parse_args()
    persona = safe_id(args.persona)
    character_id = safe_id(args.legacy_character)
    legacy_root = Path(args.legacy_root).expanduser().resolve()
    roles_root = Path(args.roles_root).expanduser().resolve()
    source_dir = (legacy_root / "characters" / character_id).resolve()
    target_role = (roles_root / persona).resolve()
    target_voice = target_role / "voice"
    if not source_dir.is_dir():
        raise FileNotFoundError(f"Legacy character folder not found: {source_dir}")
    if not target_role.is_dir():
        raise FileNotFoundError(f"Rabi persona folder not found: {target_role}")
    source_index = source_dir / "voice-index.json"
    if not source_index.is_file():
        raise FileNotFoundError(f"Legacy voice index not found: {source_index}")

    raw_index = read_json(source_index)
    rows = raw_index.get("entries", []) if isinstance(raw_index, dict) else raw_index
    if not isinstance(rows, list):
        raise ValueError("Legacy voice index must be a list or an object with entries.")
    normalized_entries: list[dict[str, Any]] = []
    copied_audio: dict[Path, Path] = {}
    for raw_entry in rows:
        if not isinstance(raw_entry, dict) or not raw_entry.get("audio_file"):
            continue
        source_audio, relative_audio = source_audio_for_entry(source_dir, character_id, raw_entry)
        runtime = {key: raw_entry[key] for key in RUNTIME_ENTRY_KEYS if key in raw_entry}
        runtime["audio_file"] = (Path("audio") / relative_audio).as_posix()
        normalized_entries.append(runtime)
        copied_audio[source_audio] = target_voice / "audio" / relative_audio

    profile = legacy_profile(legacy_root, character_id)
    plan = {
        "persona": persona,
        "legacy_character": character_id,
        "source": str(source_dir),
        "target": str(target_voice),
        "entries": len(normalized_entries),
        "audio_files": len(copied_audio),
        "default_model": args.default_model,
    }
    print(json.dumps({"dry_run": not args.execute, **plan}, ensure_ascii=False, indent=2))
    if not args.execute:
        return 0

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    backup: Path | None = None
    if target_voice.exists():
        backup = target_role / "voice-backups" / timestamp
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(target_voice, backup)
    target_voice.mkdir(parents=True, exist_ok=True)
    for source, target in copied_audio.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    write_json(target_voice / "voice-index.json", {"version": 1, "persona_id": persona, "entries": normalized_entries})
    with (target_voice / "dialogue-examples.jsonl").open("w", encoding="utf-8") as output:
        for entry in normalized_entries:
            output.write(json.dumps({
                key: entry[key]
                for key in ("id", "title", "text", "text_zh", "text_ja", "text_ko", "emotion_tags", "emotion_vector", "match_patterns")
                if key in entry
            }, ensure_ascii=False) + "\n")
    write_json(target_voice / "voice-profile.json", {
        "version": 1,
        "persona_id": persona,
        "default_model": args.default_model,
        "preferred_models": ["local-tts/gpt-sovits", "local-tts/indextts2", "local-tts/qwen3-tts-0.6b-base"],
        "source_character_id": character_id,
        "display_name": profile.get("display_name_zh") or profile.get("display_name") or character_id,
        "voice_style_summary": profile.get("style_summary_zh") or profile.get("style_summary") or "",
        "matching_policy": "Select local reference audio by dialogue meaning, emotion tags/vector, and match patterns. Never overwrite persona.md.",
        "privacy": {"local_private_only": True, "do_not_commit_audio": True},
    })
    (target_voice / "voice-character-context.md").write_text(
        "# 声线角色上下文\n\n"
        "> 这里只保存会影响声音表达的来源角色资料，不覆盖上级目录的 `persona.md`。\n\n"
        f"- 来源角色：{profile.get('display_name_zh') or profile.get('display_name') or character_id}\n"
        f"- 声线风格：{profile.get('style_summary_zh') or profile.get('style_summary') or '未记录'}\n"
        f"- 来源页面：{profile.get('source_profile_url') or '未记录'}\n"
        "- 运行原则：事实、价值观和人格边界以 Rabi persona 为准；本文件仅影响语气、情绪与参考台词选择。\n",
        encoding="utf-8",
    )
    report = {"executed_at": timestamp, "backup": str(backup) if backup else None, **plan}
    write_json(target_voice / "reports" / f"migration-{timestamp}.json", report)
    print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
