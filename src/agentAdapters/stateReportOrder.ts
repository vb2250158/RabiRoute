export type AgentStateReportDecision = "accept" | "invalid-generation" | "out-of-order";

export function agentStateReportDecision(
  expectedGeneration: string | undefined,
  incomingGeneration: unknown,
  incomingSequence: unknown,
  previousSequence: unknown
): AgentStateReportDecision {
  const generation = typeof incomingGeneration === "string" ? incomingGeneration.trim() : "";
  const sequence = Number(incomingSequence);
  if (!expectedGeneration || generation !== expectedGeneration || !Number.isSafeInteger(sequence) || sequence < 1) {
    return "invalid-generation";
  }
  const previous = Number(previousSequence ?? 0);
  return sequence > previous ? "accept" : "out-of-order";
}
