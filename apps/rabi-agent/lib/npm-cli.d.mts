export type NpmCliResolveOptions = Readonly<{
  execPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: string;
  isFile?: (filename: string) => boolean;
}>;

export function resolveNpmCli(options?: NpmCliResolveOptions): string;
