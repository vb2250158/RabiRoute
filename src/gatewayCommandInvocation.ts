export type GatewayCommandInvocation =
  | "wearable-health-alert-stdin"
  | "delivery-replay"
  | "manual-trigger"
  | "local-agent-message"
  | "speech-message"
  | "direct-agent-envelope"
  | "gateway-main";

export function resolveGatewayCommandInvocation(argv: readonly string[]): GatewayCommandInvocation {
  if (argv.includes("--wearable-health-alert-stdin")) return "wearable-health-alert-stdin";
  if (argv.some((arg) => arg.startsWith("--delivery-replay=") || arg.startsWith("--delivery-replay-message="))) {
    return "delivery-replay";
  }
  if (argv.some((arg) => arg.startsWith("--manual-trigger="))) return "manual-trigger";
  if (argv.some((arg) => arg.startsWith("--plan-feedback-message=") || arg.startsWith("--role-panel-message="))) {
    return "local-agent-message";
  }
  if (argv.some((arg) => arg.startsWith("--speech-message="))) return "speech-message";
  if (argv.some((arg) => arg.startsWith("--direct-agent-envelope="))) return "direct-agent-envelope";
  return "gateway-main";
}
