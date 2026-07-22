from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path
from typing import MutableMapping, MutableSequence, Sequence


_RUNTIME_DIRECTORY = "runtime"


def resolve_service_root(
    *,
    executable: str | Path | None = None,
    script_path: str | Path | None = None,
    environment: MutableMapping[str, str] | None = None,
    frozen: bool | None = None,
) -> Path:
    env = environment if environment is not None else os.environ
    configured = str(env.get("RABISPEECH_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else bool(frozen)
    if is_frozen:
        host = Path(executable or sys.executable).expanduser().resolve()
        return host.parent.parent if host.parent.name.lower() == _RUNTIME_DIRECTORY else host.parent

    source = Path(script_path or __file__).expanduser().resolve()
    return source.parents[1]


def configure_runtime(
    service_root: str | Path,
    *,
    environment: MutableMapping[str, str] | None = None,
    module_paths: MutableSequence[str] | None = None,
) -> dict[str, str]:
    root = Path(service_root).expanduser().resolve()
    dependencies = root / ".deps"
    config = root / "config.json"
    if not dependencies.is_dir():
        raise RuntimeError(f"RabiSpeech dependencies are missing: {dependencies}")
    if not config.is_file():
        example = root / "config.example.json"
        if not example.is_file():
            raise RuntimeError(f"RabiSpeech configuration is missing: {config}")
        config.write_bytes(example.read_bytes())

    env = environment if environment is not None else os.environ
    paths = module_paths if module_paths is not None else sys.path
    for item in (str(root), str(dependencies)):
        if item not in paths:
            paths.insert(0, item)

    existing_python_path = str(env.get("PYTHONPATH") or "").strip()
    env["PYTHONPATH"] = os.pathsep.join(
        item for item in (str(dependencies), str(root), existing_python_path) if item
    )
    env["RABISPEECH_ROOT"] = str(root)
    env.setdefault("RABISPEECH_CONFIG", str(config))

    nvidia_root = dependencies / "nvidia"
    nvidia_bins = sorted(
        str(candidate)
        for candidate in nvidia_root.glob("*/bin")
        if candidate.is_dir()
    )
    if nvidia_bins:
        env["PATH"] = os.pathsep.join([*nvidia_bins, str(env.get("PATH") or "")])

    return {
        "service_root": str(root),
        "dependencies": str(dependencies),
        "config": str(config),
    }


def run_server() -> None:
    uvicorn = importlib.import_module("uvicorn")
    app_module = importlib.import_module("rabispeech.app")
    config_module = importlib.import_module("rabispeech.config")
    settings = config_module.load_settings()
    uvicorn.run(
        app_module.create_app(settings),
        host=settings.server.host,
        port=settings.server.port,
        log_level="info",
        ws="auto",
    )


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(argv if argv is not None else sys.argv[1:])
    root = resolve_service_root()
    runtime = configure_runtime(root)
    if "--probe" in arguments:
        print(
            json.dumps(
                {
                    **runtime,
                    "executable": str(Path(sys.executable).resolve()),
                    "frozen": bool(getattr(sys, "frozen", False)),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    run_server()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
