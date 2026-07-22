import fs from "node:fs";
import path from "node:path";

export type GatewayChildCommand = {
  command: string;
  args: string[];
  shell: false;
};

/**
 * Resolve the gateway entry without an intermediate npm/cmd shell.
 *
 * One-shot delivery children must remain the process that Manager owns so a
 * timeout cannot leave a descendant running and deliver after the HTTP call
 * has already reported failure.
 */
export function resolveGatewayChildCommand(
  rootDir: string,
  extraArgs: string[] = [],
  existsSync: (target: fs.PathLike) => boolean = fs.existsSync
): GatewayChildCommand {
  const resolvedRoot = path.resolve(rootDir);
  const distEntry = path.join(resolvedRoot, "dist", "index.js");
  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry, ...extraArgs], shell: false };
  }

  const sourceEntry = path.join(resolvedRoot, "src", "index.ts");
  return {
    command: process.execPath,
    args: ["--import", "tsx", sourceEntry, ...extraArgs],
    shell: false
  };
}
