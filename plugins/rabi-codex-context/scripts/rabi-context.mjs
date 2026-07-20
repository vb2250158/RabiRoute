import process from "node:process";
import { requestManager, resolveManagerUrl } from "./lib/rabi-manager-client.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `Rabi Codex context CLI (Rabi PC Manager client)

Commands:
  roles
  bind --session <session-id> --role <RoleId>
  unbind --session <session-id>
  status [--session <session-id>]
  context --session <session-id> --event <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse> [--turn <turn-id>] [--prompt <text>] [--tool <tool-name>] [--input <text>] [--response <text>]
  doctor

Set RABI_MANAGER_URL to override ${resolveManagerUrl({})}.`;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command] = positional;

try {
  if (command === "roles") {
    printJson(await requestManager("/api/codex-hook/roles"));
  } else if (command === "bind") {
    if (!flags.session || !flags.role) throw new Error("bind requires --session and --role.");
    printJson(await requestManager(`/api/codex-hook/sessions/${encodeURIComponent(String(flags.session))}`, {
      method: "PUT",
      body: JSON.stringify({ roleId: flags.role })
    }));
  } else if (command === "unbind") {
    if (!flags.session) throw new Error("unbind requires --session.");
    printJson(await requestManager(`/api/codex-hook/sessions/${encodeURIComponent(String(flags.session))}`, { method: "DELETE" }));
  } else if (command === "status") {
    const pathname = flags.session
      ? `/api/codex-hook/sessions/${encodeURIComponent(String(flags.session))}`
      : "/api/codex-hook/sessions";
    printJson(await requestManager(pathname));
  } else if (command === "context") {
    if (!flags.session || !flags.event) throw new Error("context requires --session and --event.");
    printJson(await requestManager("/api/codex-hook/context", {
      method: "POST",
      body: JSON.stringify({
        session_id: flags.session,
        hook_event_name: flags.event,
        turn_id: flags.turn || undefined,
        prompt: flags.prompt || "",
        tool_name: flags.tool || undefined,
        tool_input: flags.input || undefined,
        tool_response: flags.response || undefined,
        cwd: process.cwd()
      })
    }));
  } else if (command === "doctor") {
    printJson({ managerUrl: resolveManagerUrl(), ...(await requestManager("/api/codex-hook/doctor")) });
  } else {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = command ? 2 : 0;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
