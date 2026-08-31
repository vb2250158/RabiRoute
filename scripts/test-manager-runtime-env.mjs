// Production receives this value from the Manager's bound OS endpoint.
// Tests need an explicit per-process identity URL without opening or guessing a port.
if (!String(process.env.GATEWAY_MANAGER_URL || "").trim()) {
  const ephemeralTestPort = 49_152 + (process.pid % 16_383);
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${ephemeralTestPort}`;
}

// Test fixtures bind ephemeral loopback listeners. Node's environment proxy mode
// must never route those requests through a user-configured HTTP proxy.
const noProxyEntries = [process.env.NO_PROXY, process.env.no_proxy]
  .flatMap(value => String(value || "").split(","))
  .map(value => value.trim())
  .filter(Boolean);
for (const loopback of ["127.0.0.1", "localhost", "::1"]) {
  if (!noProxyEntries.includes(loopback)) noProxyEntries.push(loopback);
}
process.env.NO_PROXY = [...new Set(noProxyEntries)].join(",");
process.env.no_proxy = process.env.NO_PROXY;
