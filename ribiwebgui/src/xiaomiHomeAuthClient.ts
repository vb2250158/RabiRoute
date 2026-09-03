import type { XiaomiHomeAuthorizationSnapshot } from "@shared/xiaomiHomeAuthContract";

export type XiaomiHomeConnectInput = Readonly<{
  accessToken: string;
  baseUrl: string;
  settingsRevision: string;
  authorizationRevision: string;
}>;

type ApiEnvelope<T> = Readonly<{
  code?: number;
  data?: T;
  message?: string;
  error?: Readonly<{ message?: string }>;
}>;

type ManagerMeta = Readonly<{
  applicationGenerationId?: string;
  managerInstanceId?: string;
}>;

async function json<T>(response: Response): Promise<T> {
  let body: ApiEnvelope<T>;
  try {
    body = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new Error(`Xiaomi Home authorization request failed: HTTP ${response.status}`);
  }
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(body.error?.message || body.message || `Xiaomi Home authorization request failed: HTTP ${response.status}`);
  }
  return body.data;
}

async function lifecycleHeaders(operationId: string): Promise<Record<string, string>> {
  const response = await fetch("/meta", { headers: { accept: "application/json" } });
  const meta = await response.json() as ManagerMeta;
  const applicationGenerationId = String(meta.applicationGenerationId || "").trim();
  const managerInstanceId = String(meta.managerInstanceId || "").trim();
  if (!response.ok || !applicationGenerationId || !managerInstanceId) {
    throw new Error("Manager lifecycle identity is unavailable; reload WebGUI after Host reports READY.");
  }
  return {
    "x-rabiroute-expected-application-generation-id": applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": managerInstanceId,
    "idempotency-key": operationId
  };
}

function operationId(kind: string): string {
  return `xiaomi-home-${kind}-${crypto.randomUUID()}`;
}

async function read(): Promise<XiaomiHomeAuthorizationSnapshot> {
  return json(await fetch("/api/agent/xiaomi-home/auth", {
    headers: { accept: "application/json" }
  }));
}

async function connect(input: XiaomiHomeConnectInput): Promise<XiaomiHomeAuthorizationSnapshot> {
  const fences = await lifecycleHeaders(operationId("connect"));
  return json(await fetch("/api/agent/xiaomi-home/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...fences },
    body: JSON.stringify(input)
  }));
}

async function refresh(authorizationRevision: string): Promise<XiaomiHomeAuthorizationSnapshot> {
  const fences = await lifecycleHeaders(operationId("refresh"));
  return json(await fetch("/api/agent/xiaomi-home/auth/refresh", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...fences },
    body: JSON.stringify({ authorizationRevision })
  }));
}

async function disconnect(authorizationRevision: string): Promise<XiaomiHomeAuthorizationSnapshot> {
  const fences = await lifecycleHeaders(operationId("disconnect"));
  return json(await fetch("/api/agent/xiaomi-home/auth", {
    method: "DELETE",
    headers: { accept: "application/json", "content-type": "application/json", ...fences },
    body: JSON.stringify({ authorizationRevision })
  }));
}

export const xiaomiHomeAuthClient = { read, connect, refresh, disconnect };
