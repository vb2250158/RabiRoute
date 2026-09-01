import type {
  XiaomiHomeRuntimeSettings,
  XiaomiHomeSettingsSnapshot
} from "@shared/xiaomiHomeSettingsContract";

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
    throw new Error(`Xiaomi Home request failed: HTTP ${response.status}`);
  }
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(body.error?.message || body.message || `Xiaomi Home request failed: HTTP ${response.status}`);
  }
  return body.data;
}

async function readMeta(): Promise<Required<ManagerMeta>> {
  const response = await fetch("/meta", { headers: { accept: "application/json" } });
  const meta = await response.json() as ManagerMeta;
  const applicationGenerationId = String(meta.applicationGenerationId || "").trim();
  const managerInstanceId = String(meta.managerInstanceId || "").trim();
  if (!response.ok || !applicationGenerationId || !managerInstanceId) {
    throw new Error("Manager lifecycle identity is unavailable; reload WebGUI after Host reports READY.");
  }
  return { applicationGenerationId, managerInstanceId };
}

async function read(): Promise<XiaomiHomeSettingsSnapshot> {
  return json(await fetch("/api/agent/xiaomi-home/settings", {
    headers: { accept: "application/json" }
  }));
}

async function update(snapshot: XiaomiHomeSettingsSnapshot, settings: XiaomiHomeRuntimeSettings): Promise<XiaomiHomeSettingsSnapshot> {
  const meta = await readMeta();
  return json(await fetch("/api/agent/xiaomi-home/settings", {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-rabiroute-expected-application-generation-id": meta.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": meta.managerInstanceId
    },
    body: JSON.stringify({ revision: snapshot.revision, settings })
  }));
}

export const xiaomiHomeSettingsClient = { read, update };
