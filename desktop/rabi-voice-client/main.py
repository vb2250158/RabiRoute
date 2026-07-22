from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from rabi_voice_client.client import RabiVoiceClient, list_audio_devices
from rabi_voice_client.config import load_config


def main() -> int:
    runtime_root = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Rabi remote microphone and speaker client")
    parser.add_argument("--config", default=str(runtime_root / "config.json"))
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--headless", action="store_true", help="Run without the desktop control window")
    args = parser.parse_args()
    if args.list_devices:
        devices = list_audio_devices()
        if sys.stdout is not None:
            print(devices)
        else:
            (runtime_root / "audio-devices.txt").write_text(devices + "\n", encoding="utf-8")
        return 0
    if not args.headless:
        from rabi_voice_client.gui import run_gui

        return run_gui(Path(args.config))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    client = RabiVoiceClient(load_config(args.config))
    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
