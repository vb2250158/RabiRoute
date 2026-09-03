import {
  canonicalCodexWorkspacePath,
  isCodexTaskId,
  sameCodexWorkspace
} from "./codexTaskIdentity.js";

const recentCreationTtlMs = 60_000;

export type CodexSessionThread = {
  id: string;
  title: string;
  updatedAt: string;
  cwd?: string;
  archived?: boolean;
};

export type CodexSessionResolution<TThread extends CodexSessionThread> =
  | { kind: "id" | "name" | "created"; thread: TThread }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: TThread[] }
  | { kind: "archived"; thread: TThread };

export type CodexSessionResolverDependencies<TThread extends CodexSessionThread> = {
  /** Stable owner used to share in-flight/recent creations across requests. */
  scope: object;
  read: (threadId: string) => Promise<TThread | null>;
  list: (params: { title: string; cwd: string }) => Promise<TThread[]>;
  create: (context?: {
    reason: "missing" | "archived";
    previousThread?: TThread;
  }) => Promise<TThread>;
};

export type CodexSessionDeliveryDependencies<TThread extends CodexSessionThread> =
  CodexSessionResolverDependencies<TThread> & {
    deliver: (params: { thread: TThread; prompt: string }) => Promise<void>;
  };

type IdempotentCreation = {
  promise: Promise<CodexSessionThread>;
  settledAt?: number;
};

const creationsByScope = new WeakMap<object, Map<string, IdempotentCreation>>();

function creationKey(title: string, cwd: string, replacementForThreadId = ""): string {
  return JSON.stringify(["codex-desktop", canonicalCodexWorkspacePath(cwd), title, replacementForThreadId]);
}

function uniquelyLatestThread<TThread extends CodexSessionThread>(matches: TThread[]): TThread | null {
  let latest: TThread | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  let latestCount = 0;
  for (const thread of matches) {
    const parsed = Date.parse(thread.updatedAt);
    const updatedAt = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    if (updatedAt > latestTime) {
      latest = thread;
      latestTime = updatedAt;
      latestCount = 1;
    } else if (updatedAt === latestTime) {
      latestCount += 1;
    }
  }
  return latestCount === 1 ? latest : null;
}

async function createIdempotently<TThread extends CodexSessionThread>(
  title: string,
  cwd: string,
  dependencies: CodexSessionResolverDependencies<TThread>,
  context: { reason: "missing" | "archived"; previousThread?: TThread }
): Promise<TThread> {
  const key = creationKey(title, cwd, context.previousThread?.id);
  let creations = creationsByScope.get(dependencies.scope);
  if (!creations) {
    creations = new Map();
    creationsByScope.set(dependencies.scope, creations);
  }

  const existing = creations.get(key);
  if (existing && (existing.settledAt === undefined || Date.now() - existing.settledAt <= recentCreationTtlMs)) {
    return existing.promise as Promise<TThread>;
  }
  if (existing) creations.delete(key);

  const entry: IdempotentCreation = { promise: Promise.resolve().then(() => dependencies.create(context)) };
  creations.set(key, entry);
  entry.promise.then(
    () => { entry.settledAt = Date.now(); },
    () => {
      if (creations?.get(key) === entry) creations.delete(key);
    }
  );
  return entry.promise as Promise<TThread>;
}

/**
 * Canonical Codex task resolver shared by Manager APIs and real Gateway
 * delivery. It never sends a prompt; the caller must deliver through the
 * Desktop owner after this function returns a task.
 */
export async function resolveCodexSession<TThread extends CodexSessionThread>(
  params: {
    threadId?: string;
    title: string;
    cwd: string;
    createIfMissing: boolean;
  },
  dependencies: CodexSessionResolverDependencies<TThread>
): Promise<CodexSessionResolution<TThread>> {
  const threadId = params.threadId?.trim() || "";
  if (isCodexTaskId(threadId)) {
    const exact = await dependencies.read(threadId);
    // The Desktop sidebar Name and saved cwd can change independently of task
    // identity. The opaque id alone identifies an exact existing task; cwd is
    // the execution context requested for the next turn.
    // Explicit name edits clear threadId in the UI before this resolver runs.
    if (exact) {
      if (!exact.archived) return { kind: "id", thread: exact };
      // An archived binding is terminal history. Delivery must create one
      // replacement even when another task happens to share its title; name
      // lookup is only valid after the old binding no longer identifies a task.
      if (!params.createIfMissing) return { kind: "archived", thread: exact };
      return {
        kind: "created",
        thread: await createIdempotently(params.title, params.cwd, dependencies, {
          reason: "archived",
          previousThread: exact
        })
      };
    }
  }

  const matches = (await dependencies.list({ title: params.title, cwd: params.cwd }))
    .filter((thread) => !thread.archived)
    .filter((thread) => thread.title === params.title)
    .filter((thread) => !thread.cwd || sameCodexWorkspace(thread.cwd, params.cwd));
  if (matches.length > 1) {
    const latest = uniquelyLatestThread(matches);
    if (latest) return { kind: "name", thread: latest };
    return { kind: "ambiguous", candidates: matches };
  }
  if (matches[0]) return { kind: "name", thread: matches[0] };
  if (!params.createIfMissing) return { kind: "missing" };

  return {
    kind: "created",
    thread: await createIdempotently(params.title, params.cwd, dependencies, { reason: "missing" })
  };
}

/** Resolve/create the canonical task, then deliver only through its owner. */
export async function resolveAndDeliverCodexSession<TThread extends CodexSessionThread>(
  params: {
    threadId?: string;
    title: string;
    cwd: string;
    prompt: string;
  },
  dependencies: CodexSessionDeliveryDependencies<TThread>,
  beforeDeliver?: (resolution: Extract<CodexSessionResolution<TThread>, { thread: TThread }>) => void | Promise<void>
): Promise<Extract<CodexSessionResolution<TThread>, { thread: TThread }>> {
  const resolution = await resolveCodexSession({
    threadId: params.threadId,
    title: params.title,
    cwd: params.cwd,
    createIfMissing: true
  }, dependencies);

  if (resolution.kind === "ambiguous") {
    throw new Error(`Codex Desktop task name is ambiguous: ${params.title}`);
  }
  if (resolution.kind === "archived") {
    throw new Error(`Codex Desktop task is archived; restore or select it before delivery: ${params.title}`);
  }
  if (resolution.kind === "missing") {
    throw new Error(`Codex Desktop task could not be resolved: ${params.title}`);
  }

  await beforeDeliver?.(resolution);
  await dependencies.deliver({ thread: resolution.thread, prompt: params.prompt });
  return resolution;
}
