type NamedSession = { id: string; label: string };
type Operation = { requestId: string; label: string };
type Pointer = Operation & { kind: "click" | "longPress" | "swipe"; x: number; y: number; startX: number; startY: number; remainingMs: number };
export type PhoneScreenFeedback = {
  layoutRevision: string;
  observations: NamedSession[];
  operation?: Operation;
  pointer?: Pointer;
};

export function phoneRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const pointFraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function readPhoneScreenFeedback(result: Record<string, unknown>): PhoneScreenFeedback | undefined {
  const { layoutRevision, activity } = result;
  if (result.state !== "sharing" || typeof layoutRevision !== "string" || !phoneRecord(activity)) return undefined;
  const observations = Array.isArray(activity.observations) ? activity.observations.filter((entry): entry is NamedSession =>
    phoneRecord(entry) && typeof entry.id === "string" && typeof entry.label === "string") : [];
  const operation = activity.operation;
  const reader = phoneRecord(operation) && typeof operation.requestId === "string" && typeof operation.label === "string"
    ? { requestId: operation.requestId, label: operation.label } : undefined;
  const marker = phoneRecord(activity.pointer) ? activity.pointer : {};
  const { requestId, label, kind, x, y, startX, startY, remainingMs } = marker;
  const pointer = typeof requestId === "string" && typeof label === "string"
    && (kind === "click" || kind === "longPress" || kind === "swipe")
    && pointFraction(x) && pointFraction(y) && pointFraction(startX) && pointFraction(startY)
    && typeof remainingMs === "number" && remainingMs > 0 && remainingMs <= 1650
    ? { requestId, label, kind, x, y, startX, startY, remainingMs } as const : undefined;
  return { layoutRevision, observations, operation: reader, pointer };
}

export function phonePreviewPointer(feedback: PhoneScreenFeedback | undefined, source: Record<string, unknown> | undefined) {
  return feedback && feedback.layoutRevision === source?.layoutRevision ? feedback.pointer : undefined;
}
