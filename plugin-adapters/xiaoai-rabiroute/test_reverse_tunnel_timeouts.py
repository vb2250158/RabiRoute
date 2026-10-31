import json
import os
from pathlib import Path
import runpy
import sys
import types
import unittest
from unittest.mock import Mock, patch


class ReverseTunnelTimeoutTests(unittest.TestCase):
    def load(self, overrides):
        client = Mock()
        client.get_transport.return_value = None
        paramiko = types.SimpleNamespace(SSHClient=lambda: client, AutoAddPolicy=lambda: None)
        with patch.dict(os.environ, {
            "RABIROUTE_TIMEOUT_OVERRIDES": overrides,
            "XIAOAI_SSH_HOST": "speaker.example",
            "XIAOAI_SSH_PASSWORD": "fixture-only",
        }, clear=True), patch.dict(sys.modules, {"paramiko": paramiko}), patch.object(Path, "exists", return_value=False):
            module = runpy.run_path(str(Path(__file__).with_name("reverse-tunnel.py")))
        return module, client

    def test_snapshot_controls_actual_ssh_connect_arguments(self):
        module, client = self.load(json.dumps({"xiaoai.ssh.connect": 125, "xiaoai.ssh.banner": 250, "xiaoai.ssh.auth": 500}))
        with self.assertRaisesRegex(RuntimeError, "transport"):
            module["main"]()
        kwargs = client.connect.call_args.kwargs
        self.assertEqual((kwargs["timeout"], kwargs["banner_timeout"], kwargs["auth_timeout"]), (0.125, 0.25, 0.5))

    def test_absent_and_invalid_overrides_preserve_defaults(self):
        for raw in ["{}", "invalid", "[]", '{"xiaoai.ssh.connect":true}', '{"xiaoai.ssh.connect":0}', '{"xiaoai.ssh.connect":2147483648}']:
            module, _ = self.load(raw)
            self.assertEqual(module["timeout_seconds"]("xiaoai.ssh.connect", 10), 10)


if __name__ == "__main__":
    unittest.main()
