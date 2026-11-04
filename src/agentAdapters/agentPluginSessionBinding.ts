/** Field ownership is installed package metadata, including when execution is disabled. */
export type AgentSessionBindingDescriptor = Readonly<{
  type: string;
  sessionBinding?: Readonly<{
    sessionId?: string;
    sessionName?: string;
    workspace?: string;
    defaultName?: string;
  }>;
}>;

export type ConfiguredAgentSessionBinding = {
  sessionId?: string;
  sessionName?: string;
  workspace?: string;
};

/** Active immutable owners outrank newer installed bytes; disabled packages retain their metadata. */
export function mergeAgentSessionDescriptors<T extends AgentSessionBindingDescriptor>(
  installed: Iterable<T>, active: Iterable<T>
): ReadonlyMap<string, T> {
  const descriptors = new Map<string, T>();
  for (const descriptor of installed) descriptors.set(descriptor.type, descriptor);
  for (const descriptor of active) descriptors.set(descriptor.type, descriptor);
  return descriptors;
}

/** Missing fields stay missing; another platform's saved task is never a default. */
export function readAgentSessionBinding(
  descriptor: AgentSessionBindingDescriptor | undefined,
  definition: object
): ConfiguredAgentSessionBinding {
  const values = definition as Readonly<Record<string, unknown>>;
  const binding: ConfiguredAgentSessionBinding = {};
  for (const name of ["sessionId", "sessionName", "workspace"] as const) {
    const field = descriptor?.sessionBinding?.[name];
    const value = field ? values[field] : undefined;
    if (typeof value === "string") binding[name] = value;
  }
  if (!binding.sessionName && descriptor?.sessionBinding?.defaultName) {
    binding.sessionName = descriptor.sessionBinding.defaultName;
  }
  return binding;
}
