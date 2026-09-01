import {
  executeRouteCatalogTransaction,
  RouteCatalogRevisionConflictError,
  type RouteCatalogChildResult,
  type RouteCatalogTransactionInput
} from "./routeCatalogTransaction.js";
import { RouteCatalogIdempotencyConflictError } from "./routeCatalogDurableTransaction.js";

function inputFromEnvironment(): RouteCatalogTransactionInput {
  const encoded = process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_INPUT;
  if (!encoded) throw new Error("Route catalog child input is missing.");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<RouteCatalogTransactionInput>;
  if (typeof parsed.requestId !== "string" || !parsed.requestId.trim()) {
    throw new Error("Route catalog child requires requestId.");
  }
  if (typeof parsed.attemptToken !== "string" || !parsed.attemptToken.trim()) {
    throw new Error("Route catalog child requires attemptToken.");
  }
  if (typeof parsed.operationId !== "string" || !/^[A-Za-z0-9:._-]{1,256}$/.test(parsed.operationId)) {
    throw new Error("Route catalog child requires a valid operationId.");
  }
  if (typeof parsed.rootDir !== "string" || !parsed.rootDir.trim()) {
    throw new Error("Route catalog child requires rootDir.");
  }
  if (typeof parsed.routeRoot !== "string" || !parsed.routeRoot.trim()) {
    throw new Error("Route catalog child requires routeRoot.");
  }
  if (typeof parsed.rolesRoot !== "string" || !parsed.rolesRoot.trim()) {
    throw new Error("Route catalog child requires rolesRoot.");
  }
  if (!Number.isInteger(parsed.managerPort) || Number(parsed.managerPort) <= 0) {
    throw new Error("Route catalog child requires the active Manager port.");
  }
  if (!parsed.operation || typeof parsed.operation !== "object" || typeof parsed.operation.kind !== "string") {
    throw new Error("Route catalog child requires an operation.");
  }
  return parsed as RouteCatalogTransactionInput;
}

function sendAndExit(result: RouteCatalogChildResult, exitCode: number): void {
  if (typeof process.send !== "function") {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exit(exitCode);
    return;
  }
  process.send(result, () => {
    process.disconnect();
    process.exit(exitCode);
  });
}

try {
  sendAndExit({ ok: true, snapshot: executeRouteCatalogTransaction(inputFromEnvironment()) }, 0);
} catch (error) {
  sendAndExit({
    ok: false,
    errorCode: error instanceof RouteCatalogRevisionConflictError
      ? "revision_conflict"
      : error instanceof RouteCatalogIdempotencyConflictError
        ? "idempotency_conflict"
      : "transaction_failed",
    error: error instanceof Error ? error.message : String(error)
  }, 1);
}
