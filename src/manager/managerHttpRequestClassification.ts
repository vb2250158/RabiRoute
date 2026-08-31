export function isManagerControlRequestPath(pathname: string): boolean {
  return pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/roles"
    || pathname.startsWith("/roles/")
    || pathname === "/health"
    || pathname === "/meta"
    || pathname === "/gateways"
    || pathname.startsWith("/gateways/")
    || pathname === "/network-options"
    || pathname === "/reload"
    || pathname === "/manager-config"
    || pathname === "/open-config-file"
    || pathname === "/manager"
    || pathname.startsWith("/manager/");
}
