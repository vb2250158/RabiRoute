/** NapCat owns its legacy instance normalization and primary-account transport projection. */
export function projectRouteTransport(activation, boot) {
  if (!activation?.__routeTransport) return undefined;
  const fields = ["napcatInstances", "napcatHttpUrl", "napcatWebuiUrl", "napcatAccessToken", "napcatWebuiToken"];
  const inherited = new Set(activation.__routeInheritedFields ?? []);
  if (fields.every(key => inherited.has(key))) return Object.fromEntries([...fields, "gatewayPort"].map(key => [key, structuredClone(boot[key])]));
  const values = { ...boot, ...Object.fromEntries(fields.filter(key => !inherited.has(key)).map(key => [key, activation.__routeTransport[key]])) };
  const raw = activation.__routeTransportInputs?.napcatInstances;
  const instances = Array.isArray(raw) ? raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const gatewayPort = Number(item.gatewayPort ?? item.wsPort ?? item.port);
    if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) return undefined;
    const id = String(item.id || "").trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || `napcat-${index + 1}`;
    return { id, name: String(item.name || item.label || id), enabled: item.enabled !== false, autoLoginOnRabiStart: item.autoLoginOnRabiStart !== false,
      gatewayPort, httpUrl: String(item.httpUrl || item.napcatHttpUrl || "http://127.0.0.1:3000"), webuiUrl: String(item.webuiUrl || item.napcatWebuiUrl || "http://127.0.0.1:6099/webui"),
      accessToken: String(item.accessToken || item.napcatAccessToken || ""), webuiToken: String(item.webuiToken || item.napcatWebuiToken || ""),
      launchCommand: typeof item.launchCommand === "string" ? item.launchCommand : undefined, workingDir: typeof item.workingDir === "string" ? item.workingDir : undefined };
  }).filter(Boolean) : [];
  if (!instances.length) instances.push({ id: "default", name: "默认 NapCat", enabled: true, autoLoginOnRabiStart: true, gatewayPort: boot.gatewayPort,
    httpUrl: values.napcatHttpUrl, webuiUrl: values.napcatWebuiUrl, accessToken: values.napcatAccessToken, webuiToken: values.napcatWebuiToken,
    launchCommand: boot.napcatInstances?.find(item => item.id === "default")?.launchCommand,
    workingDir: boot.napcatInstances?.find(item => item.id === "default")?.workingDir });
  const primary = instances.find(item => item.enabled) ?? instances[0];
  return { napcatInstances: instances, napcatHttpUrl: primary.httpUrl, napcatWebuiUrl: primary.webuiUrl,
    napcatAccessToken: primary.accessToken, napcatWebuiToken: primary.webuiToken ?? "", gatewayPort: primary.gatewayPort };
}
