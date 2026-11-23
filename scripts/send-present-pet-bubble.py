"""Send a local role-panel message only from an active Windows console desktop."""

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import subprocess
from urllib.parse import quote, urlsplit
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def presence():
    kernel, user = ctypes.windll.kernel32, ctypes.windll.user32
    session = wintypes.DWORD()
    if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        return "unknown", None
    console = kernel.WTSGetActiveConsoleSessionId() & 0xffffffff
    if session.value != console or console == 0xffffffff:
        return "away", None
    user.OpenInputDesktop.restype = wintypes.HANDLE
    desktop = user.OpenInputDesktop(0, False, 0x0001)
    if not desktop:
        return "locked_or_unknown", None
    try:
        name = ctypes.create_unicode_buffer(256)
        needed = wintypes.DWORD()
        handle = wintypes.HANDLE(desktop)
        if not user.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed)):
            return "unknown", None
        if name.value.lower() != "default":
            return "locked_or_unknown", None
    finally:
        user.CloseDesktop(wintypes.HANDLE(desktop))
    class LastInput(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]
    info = LastInput()
    info.cbSize = ctypes.sizeof(info)
    if not user.GetLastInputInfo(ctypes.byref(info)):
        return "unknown", None
    return "unlocked", ((kernel.GetTickCount() - info.dwTime) & 0xffffffff) // 1000


def send(args):
    def available():
        state, idle = presence()
        return state == "unlocked" and idle is not None and idle < args.idle_seconds

    if not available():
        return {"state": "skipped_presence"}
    host = json.loads(subprocess.run([args.host, "--command", "status", "--json"], check=True,
                                     capture_output=True, encoding="utf-8-sig", timeout=12).stdout)
    base = host["managerBaseUrl"].rstrip("/")
    url = urlsplit(base)
    if url.scheme != "http" or url.hostname not in {"localhost", "127.0.0.1", "::1"} or url.username or url.password:
        raise ValueError("Expected a local Manager")
    opener = build_opener(ProxyHandler({}), NoRedirect())
    def api(path, data=None, headers=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        req = Request(base + path, data=body, headers={"Content-Type": "application/json", **(headers or {})})
        with opener.open(req, timeout=20) as response:
            return json.load(response)
    meta = api("/meta")
    if not meta["health"]["live"] or any(not host.get(k) or meta.get(k) != host[k]
                                         for k in ("applicationGenerationId", "managerInstanceId")):
        raise ValueError("Manager identity changed")
    binding = api("/api/desktop-pet/roles/" + quote(args.role, safe=""))["data"]["binding"]
    if not binding["enabled"] or not binding["bubbleEnabled"]:
        return {"state": "skipped_pet_disabled"}
    contract = api("/api/agent/help?operationId=agent.send")["data"]["operations"][0]
    headers = {"x-rabiroute-operation-id": contract["id"], "x-rabiroute-contract-version": contract["contractVersion"],
               "x-rabiroute-contract-digest": contract["contractDigest"]}
    payload = {"routeId": args.route, "deliveryId": args.delivery, "channel": "role_panel",
               "sender": {"agentType": "primary_persona", "sessionId": args.session},
               "params": {"roleId": args.role}, "payload": {"type": "text", "text": args.text}}
    if not available():
        return {"state": "skipped_presence"}
    try:
        result = api("/api/agent/send", payload, headers)
    except HTTPError as error:
        detail = json.loads(error.read())
        return {"state": "send_error", "http": error.code, "code": detail.get("errorCode") or detail.get("code"),
                "message": detail.get("message") or detail.get("repair"), "deliveryId": args.delivery}
    data = result.get("data") or result
    return {"state": data.get("status") or data.get("state") or "submitted",
            "code": result.get("code"), "deliveryId": args.delivery}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("host", "session", "role", "route", "delivery", "text"):
        parser.add_argument("--" + field, required=True)
    parser.add_argument("--idle-seconds", type=int, default=300)
    print(json.dumps(send(parser.parse_args()), ensure_ascii=True))
