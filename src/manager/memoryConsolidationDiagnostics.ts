import type { ManagerOperationalEvent } from "./operationalLog.js";

export type MemoryConsolidationFailureDiagnostic = Readonly<{
  code: string;
  runtimeLogSuffix: string;
  operationalError: NonNullable<ManagerOperationalEvent["error"]>;
}>;

const stableCodePattern = /^[A-Z][A-Z0-9_]{2,96}$/;

export function memoryConsolidationFailureDiagnostic(
  error: unknown
): MemoryConsolidationFailureDiagnostic {
  const candidate = String((error as NodeJS.ErrnoException | undefined)?.code ?? "").trim();
  const code = stableCodePattern.test(candidate)
    ? candidate
    : "MEMORY_CONSOLIDATION_FAILED";
  return Object.freeze({
    code,
    runtimeLogSuffix: `errorCode=${code}`,
    operationalError: Object.freeze({
      name: "MemoryConsolidationError",
      message: "Automatic memory consolidation failed.",
      code
    })
  });
}
