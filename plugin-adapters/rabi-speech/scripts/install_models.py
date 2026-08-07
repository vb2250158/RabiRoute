from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


CATALOG_PATH = Path(__file__).resolve().parents[1] / "model-catalog.json"


def load_catalog() -> list[dict[str, object]]:
    payload = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    models = payload.get("models")
    if not isinstance(models, list) or not models:
        raise RuntimeError("RabiSpeech model catalog is empty or invalid.")
    aliases: set[str] = set()
    normalized: list[dict[str, object]] = []
    for raw in models:
        if not isinstance(raw, dict):
            raise RuntimeError("RabiSpeech model catalog contains a non-object entry.")
        alias = str(raw.get("alias") or "").strip()
        kind = str(raw.get("kind") or "").strip()
        target = str(raw.get("target") or "").strip()
        if not alias or alias in aliases or kind not in {"huggingface", "file"} or not target:
            raise RuntimeError(f"Invalid RabiSpeech model catalog entry: {alias or '<missing alias>'}")
        aliases.add(alias)
        normalized.append(raw)
    return normalized


MODEL_CATALOG = load_catalog()
MODEL_BY_ALIAS = {str(item["alias"]): item for item in MODEL_CATALOG}


@dataclass
class InstallResult:
    alias: str
    repository: str
    target: str
    status: str
    duration_seconds: float
    error: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the local RabiSpeech benchmark model set.")
    parser.add_argument(
        "--root",
        default=os.environ.get("RABISPEECH_MODEL_ROOT", "output/models"),
        help="Private model root. Runtime weights must remain outside Git.",
    )
    parser.add_argument(
        "--model",
        action="append",
        choices=[*MODEL_BY_ALIAS, "all"],
        help="Model alias to install. Repeat the option or use all.",
    )
    parser.add_argument("--max-workers", type=int, default=4)
    parser.add_argument("--download-timeout", type=int, default=180)
    parser.add_argument("--etag-timeout", type=int, default=60)
    parser.add_argument("--list", action="store_true", help="List aliases and repositories without downloading.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.list:
        for model in MODEL_CATALOG:
            source = model.get("repository") or model.get("download_url") or ""
            print(f"{model['alias']}\t{source}\t{model['target']}")
        return 0

    selected = list(args.model or ["all"])
    aliases = [*MODEL_BY_ALIAS] if "all" in selected else list(dict.fromkeys(selected))
    root = Path(args.root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)

    # Hugging Face reads these values when its constants module is imported.
    # Speech checkpoints are multi-gigabyte files, so the default ten-second
    # timeout is too aggressive on a residential connection.
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", str(max(10, args.download_timeout)))
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", str(max(10, args.etag_timeout)))

    snapshot_download = None
    if any(str(MODEL_BY_ALIAS[alias].get("kind")) == "huggingface" for alias in aliases):
        try:
            from huggingface_hub import snapshot_download as huggingface_snapshot_download
        except ImportError as exc:
            raise SystemExit("huggingface_hub is required for Hugging Face model aliases.") from exc
        snapshot_download = huggingface_snapshot_download

    results: list[InstallResult] = []
    for alias in aliases:
        model = MODEL_BY_ALIAS[alias]
        relative = str(model["target"])
        if model.get("kind") == "file":
            url = str(model.get("download_url") or "")
            checksum = str(model.get("sha256") or "")
            target = root / relative
            started = time.perf_counter()
            print(f"INSTALLING {alias} from {url} -> {target}", flush=True)
            try:
                download_file(url, target, checksum)
                result = InstallResult(
                    alias=alias,
                    repository=url,
                    target=str(target),
                    status="installed",
                    duration_seconds=round(time.perf_counter() - started, 3),
                )
            except Exception as exc:
                result = InstallResult(
                    alias=alias,
                    repository=url,
                    target=str(target),
                    status="failed",
                    duration_seconds=round(time.perf_counter() - started, 3),
                    error=f"{type(exc).__name__}: {exc}",
                )
            results.append(result)
            print(json.dumps(asdict(result), ensure_ascii=False), flush=True)
            write_manifest(root, results)
            continue
        repository = str(model.get("repository") or "")
        target = root / relative
        target.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        print(f"INSTALLING {alias} from {repository} -> {target}", flush=True)
        try:
            download_options = {
                "repo_id": repository,
                "max_workers": max(1, args.max_workers),
            }
            if model.get("download_mode") == "cache":
                download_options["cache_dir"] = str(target)
            else:
                download_options["local_dir"] = str(target)
            assert snapshot_download is not None
            snapshot_download(**download_options)
            result = InstallResult(
                alias=alias,
                repository=repository,
                target=str(target),
                status="installed",
                duration_seconds=round(time.perf_counter() - started, 3),
            )
        except Exception as exc:  # Keep the remaining independent downloads running.
            result = InstallResult(
                alias=alias,
                repository=repository,
                target=str(target),
                status="failed",
                duration_seconds=round(time.perf_counter() - started, 3),
                error=f"{type(exc).__name__}: {exc}",
            )
        results.append(result)
        print(json.dumps(asdict(result), ensure_ascii=False), flush=True)
        write_manifest(root, results)

    return 1 if any(item.status == "failed" for item in results) else 0


def write_manifest(root: Path, results: list[InstallResult]) -> None:
    manifest_path = root / "install-manifest.json"
    merged: dict[str, dict[str, object]] = {}
    if manifest_path.is_file():
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
            for item in previous.get("models", []):
                if isinstance(item, dict) and item.get("alias"):
                    merged[str(item["alias"])] = item
        except (OSError, json.JSONDecodeError):
            pass
    for item in results:
        merged[item.alias] = asdict(item)
    manifest = {
        "schema_version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "models": [merged[key] for key in MODEL_BY_ALIAS if key in merged],
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def download_file(url: str, target: Path, expected_sha256: str) -> None:
    from urllib.request import Request, urlopen

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".part")
    digest = hashlib.sha256()
    request = Request(url, headers={"User-Agent": "RabiSpeech-model-installer"})
    try:
        with urlopen(request, timeout=180) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual.lower() != expected_sha256.lower():
            raise RuntimeError(f"SHA-256 mismatch: expected {expected_sha256}, got {actual}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
