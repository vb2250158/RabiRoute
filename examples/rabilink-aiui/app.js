function safeErrorSummary(error) {
  return String(error?.message || error || "Unknown application error")
    .replace(/rbl_[A-Za-z0-9._-]+/g, "[redacted-token]")
    .replace(/([?&](?:token|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(authorization|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

export default {
  onLaunch() {
    console.info("[RabiLink AIUI] app:launch");
  },
  onShow() {
    console.info("[RabiLink AIUI] app:show");
  },
  onHide() {
    console.info("[RabiLink AIUI] app:hide");
  },
  onError(error) {
    console.error("[RabiLink AIUI] app:error", safeErrorSummary(error));
  },
  globalData: {
    appName: "RabiLink AIUI",
    releaseVersion: "1.0.19"
  }
};
