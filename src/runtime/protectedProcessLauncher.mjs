import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WindowsJobTree } from "./windowsJobObject.mjs";

// Match Node 22's ParseNodeOptionsEnvVar: only spaces separate arguments;
// double quotes group them and backslashes escape inside double quotes.
function nodeEnvironmentArguments(value) {
  const args = [];
  let quoted = false, next = true;
  for (let index = 0; index < value.length; index++) {
    let character = value[index];
    if (character === "\\" && quoted) {
      if (++index === value.length) throw new Error("NODE_OPTIONS has an incomplete quoted escape.");
      character = value[index];
    } else if (character === " " && !quoted) { next = true; continue; }
    else if (character === '"') { quoted = !quoted; continue; }
    if (next) { args.push(character); next = false; } else args[args.length - 1] += character;
  }
  if (quoted) throw new Error("NODE_OPTIONS has an unterminated double quote.");
  return args;
}
function partitionInitialization(args, source) {
  const safe = [], requires = [], imports = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index], separator = argument.indexOf("=");
    const key = (separator < 0 ? argument : argument.slice(0, separator)).replaceAll("_", "-");
    if (["--loader", "--experimental-loader", "--eval", "--print", "--check", "--interactive", "--run", "--test",
      "--env-file", "--env-file-if-exists", "--experimental-config-file", "--experimental-default-config-file",
      "--watch", "--watch-path", "--snapshot-blob", "--build-snapshot", "--build-snapshot-config", "--experimental-sea-config",
      "-e", "-p", "-c", "-i", "inspect", "debug"].includes(key) || /^-[epci].+/.test(argument)) {
      const option = /^-[epci].+/.test(argument) ? argument.slice(0, 2) : key;
      throw new Error(`${source} option ${option} changes execution before protected Job admission. Use a normal module entry; pass environment values through options.env and initialization/custom loaders through an --import module after admission.`);
    }
    const shortRequire = argument.startsWith("-r") && !argument.startsWith("--");
    if (key === "--import" || key === "--require" || shortRequire) {
      const value = separator >= 0 ? argument.slice(separator + 1)
        : shortRequire && argument.length > 2 ? argument.slice(2) : args[++index];
      if (!value) throw new Error(`${source} ${key} requires a module specifier.`);
      (key === "--import" ? imports : requires).push(value);
    } else safe.push(argument);
  }
  return { safe, requires, imports };
}

/** Creation descriptors keep arbitrary work behind the trusted Windows self-admission gate. */
export function launchProtectedProcess(specification) {
  if (process.platform !== "win32") {
    const child = specification.kind === "fork"
      ? fork(specification.entry, specification.args ?? [], specification.options)
      : spawn(specification.command, specification.args ?? [], specification.options);
    return { child };
  }
  const options = specification.options ?? {};
  const environment = { ...(options.env ?? process.env) };
  const nodeOptionKeys = Object.keys(environment).filter(key => key.toUpperCase() === "NODE_OPTIONS");
  const nodeOptions = nodeOptionKeys.length ? String(environment[nodeOptionKeys.sort()[0]] ?? "") : undefined;
  for (const key of nodeOptionKeys) delete environment[key];
  const originalExecArgv = specification.kind === "fork" ? [...(options.execArgv ?? process.execArgv)] : [];
  const cli = partitionInitialization(originalExecArgv, "execArgv");
  // Native commands receive their original environment only after the Node
  // supervisor has joined the Job. They interpret their own NODE_OPTIONS.
  const env = specification.kind === "fork" ? partitionInitialization(nodeEnvironmentArguments(nodeOptions ?? ""), "NODE_OPTIONS")
    : { safe: [], requires: [], imports: [] };
  if (env.safe.length) environment.NODE_OPTIONS = env.safe.map(value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"').join(" ");
  const tree = new WindowsJobTree();
  const originalStdio = options.stdio ?? (specification.kind === "fork" && !options.silent ? "inherit" : "pipe");
  const stdio = Array.isArray(originalStdio) ? [...originalStdio] : [originalStdio, originalStdio, originalStdio];
  if (!stdio.includes("ipc")) stdio.push("ipc");
  const controlFd = stdio.length;
  stdio.push("pipe");
  const nonce = randomUUID();
  const launch = { ...specification, args: specification.args ?? [], options: specification.kind === "spawn" ? {
    cwd: options.cwd, detached: options.detached, shell: options.shell,
    windowsHide: options.windowsHide, windowsVerbatimArguments: options.windowsVerbatimArguments
  } : undefined, job: tree.name, nonce, controlFd, nodeOptions, originalExecArgv,
    preloads: { requires: [...env.requires, ...cli.requires], imports: [...env.imports, ...cli.imports] } };
  let child;
  try {
    child = fork(fileURLToPath(new URL("./protectedProcessBootstrap.mjs", import.meta.url)), [], {
      ...options, stdio, shell: false, windowsVerbatimArguments: false,
      execArgv: [...cli.safe, "--experimental-import-meta-resolve"],
      env: { ...environment, RABIROUTE_PROTECTED_LAUNCH: JSON.stringify(launch) }
    });
  } catch (error) { tree.abandonUnstarted(); throw error; }
  let buffer = "", admitted = false;
  const control = child.stdio[controlFd];
  control?.setEncoding("utf8");
  control?.on("data", data => {
    buffer += data;
    if (buffer.length > 16_384) { tree.noteFailure(new Error("Protected process admission response exceeded its bound.")); return; }
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    try {
      const message = JSON.parse(buffer.slice(0, end));
      if (message.nonce !== nonce || message.state !== "admitted") throw new Error(message.message || "Protected process admission was not confirmed.");
      admitted = true;
      tree.admittedByBootstrap();
    } catch (error) { tree.noteFailure(error); }
  });
  control?.once("error", error => tree.noteFailure(error));
  child.once("close", () => tree.rootDidClose());
  child.on("error", error => { tree.noteFailure(error); if (!child.pid) tree.rootDidClose(); });
  const terminate = tree.terminate.bind(tree);
  tree.terminate = () => {
    // Before admission, only the trusted bootstrap can be outside the empty Job.
    // Stop that exact process first: otherwise it could join an already-terminated
    // empty Job and create descendants after the Job's termination call.
    try {
      if (!admitted && child.exitCode === null && child.signalCode === null && !child.kill("SIGKILL")) {
        tree.noteFailure(new Error("Protected bootstrap termination was not accepted; tree exit remains unconfirmed."));
      }
    } catch (error) { tree.noteFailure(error); }
    // A failed root termination must still attempt cleanup of any admitted tree.
    terminate();
  };
  return { child, tree };
}
