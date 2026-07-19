import process from "node:process";
import {
  addRoleRoot,
  bindSession,
  doctor,
  getBinding,
  listBindings,
  listRoles,
  renderBaseContext,
  renderRecallContext,
  resolveRabiCodexHome,
  unbindSession
} from "./lib/rabi-context-store.mjs";

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
  return `Rabi Codex context CLI

Commands:
  source add --id <source-id> --path <roles-directory> [--label <label>]
  roles
  bind --session <session-id> --role <RoleId> [--root <source-id>]
  unbind --session <session-id>
  status [--session <session-id>]
  render --session <session-id> [--prompt <text>]
  doctor

Set RABI_CODEX_HOME to override the default local store.`;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, subcommand] = positional;
const home = resolveRabiCodexHome();

try {
  if (command === "source" && subcommand === "add") {
    printJson(await addRoleRoot({ id: flags.id, rootPath: flags.path, label: flags.label }, home));
  } else if (command === "roles") {
    printJson((await listRoles({ home, cwd: process.cwd() })).map((item) => ({ roleId: item.roleId, rootId: item.rootId, rootLabel: item.rootLabel })));
  } else if (command === "bind") {
    printJson(await bindSession({ sessionId: flags.session, roleId: flags.role, rootId: flags.root, cwd: process.cwd() }, home));
  } else if (command === "unbind") {
    printJson({ removed: await unbindSession(flags.session, home) });
  } else if (command === "status") {
    printJson(flags.session ? await getBinding(flags.session, home) : await listBindings(home));
  } else if (command === "render") {
    const binding = await getBinding(flags.session, home);
    if (!binding) throw new Error("Session is not bound to a Rabi role.");
    const base = await renderBaseContext(binding);
    const recall = flags.prompt ? await renderRecallContext(binding, String(flags.prompt)) : "";
    process.stdout.write(`${[base, recall].filter(Boolean).join("\n\n")}\n`);
  } else if (command === "doctor") {
    printJson(await doctor({ home, cwd: process.cwd() }));
  } else {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = command ? 2 : 0;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
