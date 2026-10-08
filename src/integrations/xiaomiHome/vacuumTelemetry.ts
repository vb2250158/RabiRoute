/** Fixed read-only properties from the official pv11cn MIoT specification. */
export const vacuumTelemetryContracts: Readonly<Record<string, readonly {siid: number; piid: number}[]>> = {
  "xiaomi.vacuum.pv11cn": [{siid: 2, piid: 2}, {siid: 2, piid: 3}, {siid: 2, piid: 26}, {siid: 20, piid: 11}]
};

const statusNames: Readonly<Record<number, string>> = {
  1: "idle", 2: "charging", 3: "break-charging", 4: "sweeping", 5: "paused",
  6: "go-charging", 7: "go-wash", 8: "remote", 9: "charged", 10: "building-map",
  11: "updating", 12: "multi-task-station-working", 13: "multi-task-recharge",
  14: "station-working", 15: "error", 16: "sweeping-and-mopping", 17: "mopping",
  18: "mapping-paused", 19: "go-charge-break", 20: "wash-break",
  21: "go-charge-building-map", 24: "go-charge-in-station-assisting-cleaning",
  25: "self-checking", 26: "summoning", 27: "sweep-summoning"
};

export function parseVacuumTelemetry(result: unknown, deviceId: string, contract: readonly {siid: number; piid: number}[]) {
  const body = result as {code?: unknown; result?: unknown};
  if (!body || body.code !== 0 || !Array.isArray(body.result) || body.result.length !== contract.length) throw new Error("Invalid telemetry response.");
  const properties = body.result;
  const values = contract.map(({siid, piid}) => {
    const matches = properties.filter((item: any) => item?.did === deviceId && item.siid === siid && item.piid === piid);
    if (matches.length !== 1 || matches[0].code !== 0) throw new Error("Invalid telemetry property identity or provider rejection.");
    return matches[0].value as unknown;
  });
  const [status, fault, locating, lidar] = values;
  const uint = (value: unknown, maximum: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
  if (!uint(status, 255) || !uint(fault, 4294967295) || typeof locating !== "boolean" || !uint(lidar, 3)) throw new Error("Invalid telemetry property value.");
  return {statusCode: status, status: statusNames[status] ?? "unknown", faultCode: fault, locating,
    lidarCode: lidar, lidar: ["bottom", "top", "lifting", "lowering"][lidar]};
}
