export class WindowsJobTree {
  readonly name: string;
  readonly settled: Promise<void>;
  readonly closed: boolean;
  readonly failure?: Error;
  activeCount(): number;
  admittedByBootstrap(): void;
  rootDidClose(): void;
  refresh(): void;
  terminate(): void;
  abandonUnstarted(): void;
}
export function joinCurrentProcessToJob(name: string): void;
