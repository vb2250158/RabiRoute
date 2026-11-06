import type { ChildProcess, ForkOptions, SpawnOptions } from "node:child_process";
export type ProtectedProcessLaunch = Readonly<
  { kind: "fork"; entry: string; args?: readonly string[]; options?: ForkOptions & { windowsHide?: boolean } }
  | { kind: "spawn"; command: string; args?: readonly string[]; options?: SpawnOptions }
>;
export type ProtectedProcessTree = {
  readonly name: string;
  readonly settled: Promise<void>;
  readonly closed: boolean;
  readonly failure?: Error;
  activeCount(): number;
  refresh(): void;
  terminate(): void;
};
/** Windows fork initialization is admitted before require/import preloads run.
 * Node CLI env/config-file flags execute before this boundary and are rejected
 * before a child is created. Pass values through options.env and initialization
 * through --import instead. Native spawn command arguments retain their contract
 * inside the already-admitted Job. No other business-source permission is added.
 */
export function launchProtectedProcess(specification: ProtectedProcessLaunch): { child: ChildProcess; tree?: ProtectedProcessTree };
