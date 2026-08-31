from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from rabiroute_tray.desktop_feature_runtime import (
    DesktopFeatureContext,
    activate_builtin_features,
    enabled_builtin_feature_ids,
)


class DesktopFeatureProfileTest(unittest.TestCase):
    def _profile(self, payload: object) -> Path:
        directory = Path(tempfile.mkdtemp())
        path = directory / "desktop-host.profile.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_profile_selects_only_enabled_builtin_features(self) -> None:
        profile = self._profile({
            "schemaVersion": 1,
            "host": "io.rabiroute.desktop.qt-host",
            "features": [
                {"id": "io.rabiroute.desktop.pet-renderer@1", "enabled": True},
                {"id": "untrusted.python.module", "enabled": True},
                {"id": "io.rabiroute.desktop.pet-renderer@1", "enabled": True},
            ],
        })
        self.assertEqual(enabled_builtin_feature_ids(profile), ("io.rabiroute.desktop.pet-renderer@1",))

    def test_profile_rejects_wrong_host(self) -> None:
        profile = self._profile({"schemaVersion": 1, "host": "other", "features": []})
        self.assertEqual(enabled_builtin_feature_ids(profile), ())

    def test_feature_activation_returns_lifecycle_disposer(self) -> None:
        disposed: list[str] = []
        context = DesktopFeatureContext("http://127.0.0.1:8790", object(), object(), object(), lambda: None)
        module = SimpleNamespace(activate=lambda _context: lambda: disposed.append("pet"))
        with patch("rabiroute_tray.desktop_feature_runtime.importlib.import_module", return_value=module):
            disposers = activate_builtin_features(("io.rabiroute.desktop.pet-renderer@1",), context)
        self.assertEqual(len(disposers), 1)
        disposers[0]()
        self.assertEqual(disposed, ["pet"])

    def test_tray_host_does_not_own_desktop_pet_controller(self) -> None:
        tray_source = (Path(__file__).parents[1] / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")
        self.assertNotIn("from .desktop_pet_controller import", tray_source)
        self.assertIn("activate_builtin_features(enabled_features, feature_context)", tray_source)


if __name__ == "__main__":
    unittest.main()
