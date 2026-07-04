#!/usr/bin/env python3

import json
import os
import sys
import time
import urllib.error
import urllib.request


endpoint = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("RABIROUTE_WEBHOOK_URL", "http://127.0.0.1:8791/webhook")
text = sys.argv[2] if len(sys.argv) > 2 else "Hello from RabiRoute Python webhook demo"

payload = {
    "type": "webhook.text",
    "source": "python-demo",
    "sourceDeviceName": "Python demo sender",
    "sessionId": f"demo-{int(time.time() * 1000)}",
    "text": text,
}

request = urllib.request.Request(
    endpoint,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status not in (200, 202, 204):
            body = response.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Webhook request failed: HTTP {response.status} {body}")
except urllib.error.HTTPError as error:
    body = error.read().decode("utf-8", errors="replace")
    raise RuntimeError(f"Webhook request failed: HTTP {error.code} {body}") from error

print(f"Sent webhook demo message to {endpoint}")
print(json.dumps(payload, ensure_ascii=False, indent=2))
