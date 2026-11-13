/** Read the original native receipt after a declared new-work switch rejects; never dispatch a replacement send. */
export function recoverDisabledAgentTask<T>(
  definition: { reconcileAction?: string } | undefined,
  body: Record<string, unknown>,
  policyError: unknown,
  reconcile: (original: Record<string, unknown>) => Promise<T>
): Promise<T> {
  if ((policyError as { code?: unknown })?.code !== "COMPUTER_FEATURE_DISABLED" || !definition?.reconcileAction) throw policyError;
  if (typeof body.deliveryId !== "string" || !body.deliveryId || !body.dsBot || typeof body.dsBot !== "object") throw policyError;
  const target = body.dsBot as { botScopeId?: unknown; botId?: unknown };
  return reconcile({ ...body, action: definition.reconcileAction }).then(result => {
    const data = result as { data?: { dsBot?: unknown }; dsBot?: unknown };
    const receipt = (data?.data?.dsBot ?? data?.dsBot) as { schemaVersion?: number; state?: string; botScopeId?: string; botId?: string; deliveryId?: string; requestId?: string; sessionId?: string } | undefined;
    if (!receipt || receipt.schemaVersion !== 1 || receipt.deliveryId !== body.deliveryId || receipt.botScopeId !== target.botScopeId || receipt.botId !== target.botId) throw new Error("The original DSBot receipt could not be confirmed. Preserve its destination and delivery ID.");
    if (receipt.state === "accepted" && (receipt.requestId !== body.deliveryId || typeof receipt.sessionId !== "string" || !receipt.sessionId)) throw new Error("The original DSBot admission receipt is incomplete. No new work was sent.");
    if (receipt.state === "not_found") throw policyError;
    if (!["accepted", "uncertain", "conflict"].includes(receipt.state ?? "")) throw new Error("The original DSBot receipt state is unknown. No new work was sent.");
    return result;
  });
}
