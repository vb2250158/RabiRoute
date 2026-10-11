"""Reconcile a private pip target against shipped requirements, without models."""
import argparse
import hashlib
import importlib.metadata
import os
from pathlib import Path
import subprocess
import sys
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name

CORE_FILES = {
    "fastapi": "fastapi/__init__.py", "uvicorn": "uvicorn/__init__.py",
    "httpx": "httpx/__init__.py", "python-multipart": "python_multipart/__init__.py",
    "numpy": "numpy/__init__.py", "scipy": "scipy/__init__.py",
    "soundfile": "soundfile.py", "sounddevice": "sounddevice.py",
    "pillow": "PIL/__init__.py", "opencv-python-headless": "cv2/__init__.py",
}


def required_packages(text):
    return [Requirement(line.strip()) for line in text.splitlines()
            if line.strip() and not line.strip().startswith("#")]


def missing_requirements(requirements, target):
    # pip --target upgrades can leave an older dist-info directory behind. Use
    # the last installed metadata, rather than filesystem enumeration order.
    installed = {}
    for dist in importlib.metadata.distributions(path=[str(target)]):
        if not dist.metadata.get("Name"):
            continue
        metadata_file = next((dist.locate_file(file) for file in dist.files or []
                              if str(file).endswith(".dist-info/METADATA")), None)
        modified = metadata_file.stat().st_mtime_ns if metadata_file and metadata_file.exists() else 0
        name = canonicalize_name(dist.metadata["Name"])
        if name not in installed or modified >= installed[name][0]:
            installed[name] = (modified, dist.version)
    missing = []
    for requirement in requirements:
        if requirement.marker and not requirement.marker.evaluate():
            continue
        name = canonicalize_name(requirement.name)
        version = installed.get(name, (0, None))[1]
        if (not version or version not in requirement.specifier
                or name in CORE_FILES and not (target / CORE_FILES[name]).is_file()):
            missing.append(str(requirement))
    return missing


def reconcile(requirements_file, target, upgrade=False):
    target.mkdir(parents=True, exist_ok=True)
    receipt = target / ".runtime-requirements.sha256"
    receipt.unlink(missing_ok=True)
    requirements = required_packages(requirements_file.read_text(encoding="utf-8-sig"))
    missing = missing_requirements(requirements, target)
    if upgrade or missing:
        arguments = ["install", "--disable-pip-version-check", "--upgrade", "--constraint", str(requirements_file), "--target", str(target)]
        arguments += ["-r", str(requirements_file)] if upgrade else missing
        # Include the private target for resolving its existing dependencies.
        bootstrap = "import sys; sys.path.insert(0, sys.argv.pop(1)); from pip._internal.cli.main import main; raise SystemExit(main())"
        subprocess.run([sys.executable, "-B", "-c", bootstrap, str(target), *arguments], check=True)
    remaining = missing_requirements(requirements, target)
    if remaining:
        raise RuntimeError("Dependencies still missing or incompatible: " + ", ".join(remaining))
    validation = "import sys; sys.path.insert(0, sys.argv[1]); import fastapi, uvicorn, httpx, python_multipart, numpy, scipy.signal, soundfile, sounddevice, PIL.Image, cv2"
    subprocess.run([sys.executable, "-B", "-c", validation, str(target)], check=True)
    temporary = receipt.with_name(receipt.name + "." + str(os.getpid()) + ".partial")
    try:
        temporary.write_text(hashlib.sha256(requirements_file.read_bytes()).hexdigest(), encoding="ascii")
        os.replace(temporary, receipt)
    finally:
        temporary.unlink(missing_ok=True)
    print("RabiSpeech dependency validation passed.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--requirements", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--upgrade", action="store_true")
    options = parser.parse_args()
    reconcile(options.requirements, options.target, options.upgrade)
