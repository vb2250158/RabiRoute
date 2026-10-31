export type PluginPublicationContext = Readonly<{
  signal: AbortSignal;
  /** Resolves only after this instance's previous activation has completely retired. */
  previousRetirement: Promise<void>;
}>;
export type PluginPublication = Readonly<{
  /** Synchronous, reversible pointer changes only; no I/O or asynchronous work. */
  publish(): void;
  /** Also called when publish itself throws. Must restore only this attempt's changes. */
  rollback(): void;
  /** Runs after publication. Failure removes the published activation; it never rolls back I/O. */
  afterPublish?(context: PluginPublicationContext): void | Promise<void>;
  /** Eligible to execute only after successful publication; must respect resource ownership. */
  retire?(): void | Promise<void>;
}>;
export type PluginPublicationRegistrar = Readonly<{
  add(publication: PluginPublication, label?: string): void;
}>;
/** SDK harness/kernel transaction helper. Plugins register through context.publication. */
export class PublicationScope implements PluginPublicationRegistrar {
  constructor(effects: Readonly<{ adopt(disposer: () => void | Promise<void>, label?: string): void; signal(): AbortSignal }>);
  add(publication: PluginPublication, label?: string): void;
  publish(): void;
  rollback(): void;
  /** Stages fallible retirement registrations, returning an infallible synchronous finalizer. */
  seal(): () => void;
  afterPublish(previousRetirement: Promise<void>): Promise<void>;
}
