from __future__ import annotations

import ast
import asyncio
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from rabispeech.remote_audio import RemoteAudioHub, RemoteAudioServerConfig
from rabispeech.config import load_settings


def desktop_discovery():
    # Execute the actual discovery function without importing microphone/GUI drivers.
    source = Path(__file__).resolve().parents[4] / "desktop/rabi-voice-client/rabi_voice_client/client.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "discover_server")
    namespace = {"socket": socket, "json": json, "os": os, "secrets": secrets, "time": time,
                 "ipaddress": ipaddress, "get_timeout_seconds": lambda _name, seconds: seconds}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
    return namespace["discover_server"]


class VoiceDiscoveryPortsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)

    async def asyncTearDown(self):
        self.temporary.cleanup()

    def hub(self, start, end=None):
        return RemoteAudioHub(RemoteAudioServerConfig(True, "127.0.0.1", 0, "fixture-token",
            self.directory / "selection.json", start, "fixture", discovery_port_end=end),
            local_player=lambda *_: None, local_stopper=lambda: None)

    async def test_udp_collision_scans_window_and_desktop_uses_the_current_ws_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as blocker:
            blocker.bind(("0.0.0.0", 0))
            occupied = blocker.getsockname()[1]
            end = min(65535, occupied + 5)
            if end == occupied:
                self.skipTest("No following UDP port in this ephemeral window")
            hub = self.hub(occupied, end)
            await hub.start()
            try:
                self.assertGreater(hub.snapshot()["discovery_port"], occupied)
                self.assertEqual(blocker.getsockname()[1], occupied)
                actual = await asyncio.to_thread(desktop_discovery(), port=occupied, port_end=end,
                                                timeout_seconds=1, broadcast_address="127.0.0.1")
                self.assertEqual(actual, f"ws://127.0.0.1:{hub.snapshot()['port']}")
                from websockets.asyncio.client import connect
                async with connect(actual, additional_headers={"Authorization": "Bearer fixture-token"}):
                    pass
            finally:
                await hub.stop()
            self.assertEqual(hub.snapshot()["port"], 0)
            self.assertEqual(hub.snapshot()["discovery_port"], 0)

    async def test_discovery_exhaustion_closes_only_its_own_ws_listener(self):
        import websockets.asyncio.server as websocket_server
        original = websocket_server.serve
        ports = []

        async def capture(*args, **kwargs):
            server = await original(*args, **kwargs)
            ports.extend(sock.getsockname()[1] for sock in server.sockets)
            return server

        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as blocker:
            blocker.bind(("0.0.0.0", 0))
            port = blocker.getsockname()[1]
            hub = self.hub(port, port)
            with patch.object(websocket_server, "serve", capture):
                with self.assertRaises(OSError):
                    await hub.start()
            self.assertFalse(hub.snapshot()["listening"])
            self.assertEqual(hub.snapshot()["port"], 0)
            self.assertEqual(blocker.getsockname()[1], port)
            self.assertTrue(ports)
            with socket.socket() as replacement:
                replacement.bind(("127.0.0.1", ports[0]))
            await hub.stop()

    async def test_legacy_request_receives_actual_port_without_requiring_a_new_client(self):
        hub = self.hub(0)
        await hub.start()
        try:
            def request():
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                    client.settimeout(1)
                    client.sendto(b"RABI_VOICE_DISCOVER_V1", ("127.0.0.1", hub.snapshot()["discovery_port"]))
                    return json.loads(client.recvfrom(4096)[0])
            response = await asyncio.to_thread(request)
            self.assertEqual(response["port"], hub.snapshot()["port"])
            self.assertNotIn("nonce", response)
        finally:
            await hub.stop()


class DesktopDiscoveryValidationTest(unittest.TestCase):
    def test_discovery_configuration_preserves_explicit_ports_and_bounds_default_scan(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            config = Path(directory) / "config.json"
            config.write_text("{}", encoding="utf-8")
            settings = load_settings(config)
            self.assertEqual(settings.remote_audio.port, 0)
            self.assertIsNone(settings.remote_audio.discovery_port_end)
            default = RemoteAudioServerConfig(True, "127.0.0.1", 0, "fixture", Path(directory) / "selection.json", 8783, "fixture")
            self.assertEqual(list(default.discovery_ports()), list(range(8783, 8804)))
            config.write_text('{"remote_audio":{"port":23456,"discovery_port":23457,"discovery_port_end":23459}}', encoding="utf-8")
            settings = load_settings(config)
            self.assertEqual(settings.remote_audio.port, 23456)
            self.assertEqual(settings.remote_audio.discovery_port_end, 23459)
            config.write_text('{"remote_audio":{"discovery_port_end":null}}', encoding="utf-8")
            self.assertIsNone(load_settings(config).remote_audio.discovery_port_end)
            with self.assertRaises(ValueError):
                RemoteAudioServerConfig(True, "127.0.0.1", 0, "fixture", Path(directory) / "selection.json", 1000, "fixture", 2000).discovery_ports()

    def test_invalid_or_stale_advertisements_never_fall_back_to_8782(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as responder, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as unrelated:
            responder.bind(("127.0.0.1", 0))
            unrelated.bind(("127.0.0.1", 0))
            responder.settimeout(1)
            port = responder.getsockname()[1]
            errors = []

            def answer():
                try:
                    raw, client = responder.recvfrom(4096)
                    nonce = json.loads(raw)["nonce"]
                    good = {"service": "rabi-voice-stream", "nonce": nonce, "port": 23456,
                            "transport": "ws", "authentication": "bearer"}
                    unrelated.sendto(json.dumps(good).encode(), client)
                    for invalid in [{**good, "nonce": "old"}, {key: value for key, value in good.items() if key != "port"},
                                    *({**good, "port": value} for value in [0, -1, 65536, True, 1.5, "8782"]),
                                    {**good, "transport": "http"}]:
                        responder.sendto(json.dumps(invalid).encode(), client)
                    responder.sendto(json.dumps(good).encode(), client)
                except BaseException as error:
                    errors.append(error)

            worker = threading.Thread(target=answer)
            worker.start()
            try:
                actual = desktop_discovery()(port=port, timeout_seconds=1, broadcast_address="127.0.0.1")
                self.assertEqual(actual, "ws://127.0.0.1:23456")
            finally:
                worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])

    def test_stale_replies_share_one_total_deadline_across_the_window(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as responder:
            responder.bind(("127.0.0.1", 0))
            responder.settimeout(0.1)
            port = responder.getsockname()[1]
            stop = threading.Event()

            def answer():
                try:
                    _, client = responder.recvfrom(4096)
                    while not stop.wait(0.005):
                        responder.sendto(json.dumps({"service": "rabi-voice-stream", "nonce": "stale", "port": 8782}).encode(), client)
                except OSError:
                    pass

            worker = threading.Thread(target=answer)
            worker.start()
            started = time.monotonic()
            try:
                with self.assertRaises(TimeoutError):
                    desktop_discovery()(port=port, port_end=min(port + 5, 65535), timeout_seconds=0.15, broadcast_address="127.0.0.1")
                self.assertLess(time.monotonic() - started, 0.8)
            finally:
                stop.set(); worker.join(2)
            self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
