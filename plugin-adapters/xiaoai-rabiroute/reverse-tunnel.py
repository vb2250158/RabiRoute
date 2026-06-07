import os
import json
import select
import socket
import socketserver
import sys
import threading
from pathlib import Path

import paramiko


def load_local_config():
    config_path = Path(__file__).with_name("xiaoai-local.config.json")
    if not config_path.exists():
        return {}
    return json.loads(config_path.read_text(encoding="utf-8"))


LOCAL_CONFIG = load_local_config()

SPEAKER_HOST = os.environ.get("XIAOAI_SSH_HOST") or LOCAL_CONFIG.get("speakerHost")
SPEAKER_USER = os.environ.get("XIAOAI_SSH_USER") or LOCAL_CONFIG.get("speakerUser", "root")
SPEAKER_PASSWORD = os.environ.get("XIAOAI_SSH_PASSWORD") or LOCAL_CONFIG.get("speakerPassword")
REMOTE_BIND_HOST = os.environ.get("XIAOAI_REMOTE_BIND_HOST") or LOCAL_CONFIG.get("remoteBindHost", "127.0.0.1")
REMOTE_PORT = int(os.environ.get("XIAOAI_REMOTE_PORT") or LOCAL_CONFIG.get("remotePort", 4399))
LOCAL_HOST = os.environ.get("XIAOAI_LOCAL_HOST") or LOCAL_CONFIG.get("localHost", "127.0.0.1")
LOCAL_PORT = int(os.environ.get("XIAOAI_LOCAL_PORT") or LOCAL_CONFIG.get("localPort", 4399))


class ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(socketserver.BaseRequestHandler):
    chain_host = LOCAL_HOST
    chain_port = LOCAL_PORT
    ssh_transport = None

    def handle(self):
        try:
            channel = self.ssh_transport.open_channel(
                "direct-tcpip",
                (self.chain_host, self.chain_port),
                self.request.getpeername(),
            )
        except Exception as exc:
            print(f"open_channel failed: {exc}", flush=True)
            return

        if channel is None:
            print("open_channel failed: channel is None", flush=True)
            return

        print(
            f"tunnel connected: {self.request.getpeername()} -> "
            f"{self.chain_host}:{self.chain_port}",
            flush=True,
        )
        while True:
            readers, _, _ = select.select([self.request, channel], [], [])
            if self.request in readers:
                data = self.request.recv(16384)
                if not data:
                    break
                channel.send(data)
            if channel in readers:
                data = channel.recv(16384)
                if not data:
                    break
                self.request.send(data)

        channel.close()
        self.request.close()


def main():
    if not SPEAKER_PASSWORD:
        raise RuntimeError("Set speakerPassword in xiaoai-local.config.json or XIAOAI_SSH_PASSWORD before starting the tunnel.")
    if not SPEAKER_HOST:
        raise RuntimeError("Set speakerHost in xiaoai-local.config.json or XIAOAI_SSH_HOST before starting the tunnel.")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        SPEAKER_HOST,
        username=SPEAKER_USER,
        password=SPEAKER_PASSWORD,
        timeout=10,
        banner_timeout=10,
        auth_timeout=10,
    )

    transport = client.get_transport()
    if transport is None:
        raise RuntimeError("SSH transport not available")

    transport.request_port_forward(REMOTE_BIND_HOST, REMOTE_PORT)
    print(
        f"reverse tunnel listening on speaker {REMOTE_BIND_HOST}:{REMOTE_PORT} "
        f"-> PC {LOCAL_HOST}:{LOCAL_PORT}",
        flush=True,
    )

    class SubHandler(Handler):
        ssh_transport = transport

    try:
        while True:
            channel = transport.accept(30)
            if channel is None:
                continue
            forwarder = socket.create_connection((LOCAL_HOST, LOCAL_PORT))
            threading.Thread(
                target=pipe_channel,
                args=(channel, forwarder),
                daemon=True,
            ).start()
    finally:
        client.close()


def pipe_channel(channel, forwarder):
    print(f"tunnel connected: speaker -> {LOCAL_HOST}:{LOCAL_PORT}", flush=True)
    try:
        while True:
            readers, _, _ = select.select([channel, forwarder], [], [])
            if channel in readers:
                data = channel.recv(16384)
                if not data:
                    break
                forwarder.sendall(data)
            if forwarder in readers:
                data = forwarder.recv(16384)
                if not data:
                    break
                channel.sendall(data)
    finally:
        channel.close()
        forwarder.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
