import { resolveGatewayCommandInvocation } from "./gatewayCommandInvocation.js";

const invocation = resolveGatewayCommandInvocation(process.argv);
if (invocation === "gateway-main") {
  const { runGatewayMain } = await import("./gatewayMain.js");
  await runGatewayMain();
} else {
  const { runGatewayCommand } = await import("./gatewayCommands.js");
  await runGatewayCommand(process.argv);
}
