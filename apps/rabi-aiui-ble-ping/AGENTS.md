# Rabi BLE Ping

This diagnostic agent exchanges only a random ping/pong nonce with the foreground Rabi mobile BLE test. Do not request audio, personal data, cloud credentials, or model execution. A matching pong proves the local BLE round trip only; it does not prove background wakeup. Keep the interactive page open. It automatically attempts one filtered scan and round trip; failures require an explicit retry. Do not bypass host interaction or permission gates.
