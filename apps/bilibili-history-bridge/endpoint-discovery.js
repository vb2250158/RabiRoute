void (async () => {
  try {
    const response = await fetch("/meta", { cache: "no-store" });
    const meta = await response.json();
    if (!response.ok || !meta.managerInstanceId || meta.managerBaseUrl !== location.origin) return;
    await chrome.runtime.sendMessage({
      type: "rabiroute-manager-endpoint",
      origin: location.origin
    });
  } catch {
    // Ordinary loopback pages are not RabiRoute and remain untouched.
  }
})();
