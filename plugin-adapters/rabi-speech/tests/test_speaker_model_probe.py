from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_speaker_model_probe_bootstraps_runtime_outside_plugin_directory(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "scripts" / "speaker_model_probe.py"
    code = (
        "import importlib.util; "
        f"spec = importlib.util.spec_from_file_location('speaker_model_probe_isolated', {str(script)!r}); "
        "module = importlib.util.module_from_spec(spec); "
        "spec.loader.exec_module(module); "
        "import rabispeech.config; "
        "print(module.PLUGIN_ROOT)"
    )
    env = dict(os.environ)
    env["PYTHONPATH"] = ""
    completed = subprocess.run(
        [sys.executable, "-c", code],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == str(script.parent.parent)
