/** Keep requests, streams and resources in the same authenticated Manager target. */
export function peerManagerPath(deviceId: string, pathname: string): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\#\r\n]/.test(pathname)) {
    throw new Error("无效的服务请求地址。");
  }
  return deviceId
    ? `/api/rabilink/peer/http/${encodeURIComponent(deviceId)}/manager${pathname}`
    : pathname;
}
