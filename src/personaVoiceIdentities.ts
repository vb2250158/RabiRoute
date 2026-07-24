import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./shared/filePersistence.js";

const MAX_TEXT = 2_000;
const MAX_ALIASES = 50;

type PersonaVoiceIdentityValue = {
  identityKey: string;
  sourceHostId: string;
  sourceHostName?: string;
  voiceprintId: string;
  displayName?: string;
  relationship?: string;
  isUser?: boolean;
  aliases: string[];
  notes?: string;
  updatedAt: string;
};

export type PersonaVoiceIdentityConflictField =
  | "sourceHostName"
  | "displayName"
  | "relationship"
  | "isUser"
  | "aliases"
  | "notes"
  | "deleted";

export type PersonaVoiceIdentityConflictCandidate = PersonaVoiceIdentityValue & {
  eventId: string;
  deleted: boolean;
};

export type PersonaVoiceIdentity = PersonaVoiceIdentityValue & {
  conflicted?: boolean;
  conflictFields?: PersonaVoiceIdentityConflictField[];
  conflictCandidates?: PersonaVoiceIdentityConflictCandidate[];
};

type PersonaVoiceIdentityEvent = PersonaVoiceIdentityValue & {
  schemaVersion: 1;
  id: string;
  supersedes?: string[];
  deleted?: boolean;
};

type PersonaVoiceIdentityState = {
  heads: PersonaVoiceIdentityEvent[];
  identity?: PersonaVoiceIdentity;
};

export type PersonaVoiceIdentityPatch = {
  sourceHostId: unknown;
  sourceHostName?: unknown;
  voiceprintId: unknown;
  displayName?: unknown;
  relationship?: unknown;
  isUser?: unknown;
  aliases?: unknown;
  notes?: unknown;
  deleted?: unknown;
};

function text(value: unknown, maxLength = MAX_TEXT): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  return normalized || undefined;
}

function requiredText(value: unknown, label: string): string {
  const normalized = text(value, 300);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function aliases(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Voice identity aliases must be an array.");
  return [...new Set(value.flatMap(item => text(item, 200) ? [text(item, 200)!] : []))]
    .sort()
    .slice(0, MAX_ALIASES);
}

function identityKey(sourceHostId: string, voiceprintId: string): string {
  return `voice-${createHash("sha256").update(sourceHostId).update("\0").update(voiceprintId).digest("hex").slice(0, 32)}`;
}

function has(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function personaVoiceIdentitiesPath(roleDir: string): string {
  return path.join(path.resolve(roleDir), "voice", "voice-identities.jsonl");
}

function events(roleDir: string): PersonaVoiceIdentityEvent[] {
  const filePath = personaVoiceIdentitiesPath(roleDir);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try {
      const item = JSON.parse(line) as PersonaVoiceIdentityEvent;
      return item?.schemaVersion === 1 && item.id && item.identityKey ? [item] : [];
    } catch {
      return [];
    }
  });
}

function eventSupersedes(event: PersonaVoiceIdentityEvent): string[] | undefined {
  if (!has(event, "supersedes") || !Array.isArray(event.supersedes)) return undefined;
  return [...new Set(event.supersedes.flatMap(item => {
    const id = text(item, 300);
    return id && id !== event.id ? [id] : [];
  }))];
}

function conflictCandidate(event: PersonaVoiceIdentityEvent): PersonaVoiceIdentityConflictCandidate {
  const { schemaVersion: _schemaVersion, id, supersedes: _supersedes, deleted, ...value } = event;
  return { ...value, eventId: id, deleted: deleted === true };
}

function scalarConsensus<T extends string | boolean>(
  candidates: PersonaVoiceIdentityConflictCandidate[],
  field: "sourceHostName" | "displayName" | "relationship" | "isUser" | "notes",
  conflicts: PersonaVoiceIdentityConflictField[]
): T | undefined {
  const values = new Map<string, T | undefined>();
  for (const candidate of candidates) {
    const value = candidate[field] as T | undefined;
    values.set(value === undefined ? "undefined" : `${typeof value}:${String(value)}`, value);
  }
  if (values.size > 1) {
    conflicts.push(field);
    return undefined;
  }
  return values.values().next().value;
}

function collapseIdentityState(heads: PersonaVoiceIdentityEvent[]): PersonaVoiceIdentity | undefined {
  const candidates = heads.map(conflictCandidate);
  const active = candidates.filter(candidate => !candidate.deleted);
  if (active.length === 0) return undefined;
  const conflicts: PersonaVoiceIdentityConflictField[] = [];
  if (active.length !== candidates.length) conflicts.push("deleted");
  const aliasShapes = new Set(active.map(candidate => JSON.stringify([...candidate.aliases].sort())));
  if (aliasShapes.size > 1) conflicts.push("aliases");
  const first = active[0]!;
  const agreedIsUser = scalarConsensus<boolean>(active, "isUser", conflicts);
  const identity: PersonaVoiceIdentity = {
    identityKey: first.identityKey,
    sourceHostId: first.sourceHostId,
    sourceHostName: scalarConsensus<string>(active, "sourceHostName", conflicts),
    voiceprintId: first.voiceprintId,
    displayName: scalarConsensus<string>(active, "displayName", conflicts),
    relationship: scalarConsensus<string>(active, "relationship", conflicts),
    isUser: conflicts.includes("deleted") ? undefined : agreedIsUser,
    aliases: [...new Set(active.flatMap(candidate => candidate.aliases))].sort(),
    notes: scalarConsensus<string>(active, "notes", conflicts),
    updatedAt: active.map(candidate => candidate.updatedAt).sort().at(-1) || first.updatedAt
  };
  if (conflicts.length > 0) {
    identity.conflicted = true;
    identity.conflictFields = conflicts;
    identity.conflictCandidates = candidates.sort((left, right) => left.eventId.localeCompare(right.eventId));
  }
  return identity;
}

function identityStates(roleDir: string): Map<string, PersonaVoiceIdentityState> {
  const grouped = new Map<string, PersonaVoiceIdentityEvent[]>();
  for (const event of events(roleDir)) {
    const group = grouped.get(event.identityKey) ?? [];
    group.push(event);
    grouped.set(event.identityKey, group);
  }
  const states = new Map<string, PersonaVoiceIdentityState>();
  for (const [key, group] of grouped) {
    const explicitSuperseded = new Set(group.flatMap(event => eventSupersedes(event) ?? []));
    const inferredSuperseded = new Set<string>();
    const currentHeads = new Set<string>();
    for (const event of group) {
      const explicit = eventSupersedes(event);
      const parents = explicit ?? [...currentHeads];
      for (const parent of parents) {
        inferredSuperseded.add(parent);
        currentHeads.delete(parent);
      }
      if (!explicitSuperseded.has(event.id)) currentHeads.add(event.id);
    }
    const superseded = new Set([...explicitSuperseded, ...inferredSuperseded]);
    let heads = group.filter(event => !superseded.has(event.id));
    if (heads.length === 0 && group.length > 0) heads = [group.at(-1)!];
    states.set(key, { heads, identity: collapseIdentityState(heads) });
  }
  return states;
}

export function listPersonaVoiceIdentities(roleDir: string): PersonaVoiceIdentity[] {
  return [...identityStates(roleDir).values()]
    .flatMap(state => state.identity ? [state.identity] : [])
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey));
}

export function findPersonaVoiceIdentity(
  roleDir: string,
  sourceHostId: string,
  voiceprintId: string
): PersonaVoiceIdentity | undefined {
  const key = identityKey(requiredText(sourceHostId, "sourceHostId"), requiredText(voiceprintId, "voiceprintId"));
  return listPersonaVoiceIdentities(roleDir).find(item => item.identityKey === key);
}

export function resolvePersonaVoiceIdentities(
  roleDir: string,
  sourceHostId: string,
  voiceprintIds: string[]
): Array<{ voiceprintId: string; identity?: PersonaVoiceIdentity }> {
  const hostId = requiredText(sourceHostId, "sourceHostId");
  const current = new Map(
    listPersonaVoiceIdentities(roleDir)
      .filter(item => item.sourceHostId === hostId)
      .map(item => [item.voiceprintId, item])
  );
  return [...new Set(voiceprintIds.flatMap(item => text(item, 300) ? [text(item, 300)!] : []))]
    .map(voiceprintId => ({ voiceprintId, identity: current.get(voiceprintId) }));
}

export function updatePersonaVoiceIdentity(
  roleDir: string,
  patch: PersonaVoiceIdentityPatch
): { identity?: PersonaVoiceIdentity; appended: boolean; deleted: boolean } {
  const sourceHostId = requiredText(patch.sourceHostId, "sourceHostId");
  const voiceprintId = requiredText(patch.voiceprintId, "voiceprintId");
  const key = identityKey(sourceHostId, voiceprintId);
  const filePath = personaVoiceIdentitiesPath(roleDir);
  return withFileLockSync(`${filePath}.lock`, () => {
    const state = identityStates(roleDir).get(key);
    const existing = state?.identity;
    const deleted = patch.deleted === true;
    const next: PersonaVoiceIdentityValue = {
      identityKey: key,
      sourceHostId,
      sourceHostName: has(patch, "sourceHostName") ? text(patch.sourceHostName, 300) : existing?.sourceHostName,
      voiceprintId,
      displayName: has(patch, "displayName") ? text(patch.displayName, 300) : existing?.displayName,
      relationship: has(patch, "relationship") ? text(patch.relationship, 500) : existing?.relationship,
      isUser: has(patch, "isUser") ? (typeof patch.isUser === "boolean" ? patch.isUser : undefined) : existing?.isUser,
      aliases: has(patch, "aliases") ? aliases(patch.aliases) : existing?.aliases ?? [],
      notes: has(patch, "notes") ? text(patch.notes) : existing?.notes,
      updatedAt: new Date().toISOString()
    };
    const comparable = (item: PersonaVoiceIdentity | undefined) => item ? JSON.stringify({
      ...item,
      updatedAt: undefined
    }) : "";
    if (!deleted && !existing?.conflicted && comparable(existing) === comparable(next)) {
      return { identity: existing, appended: false, deleted: false };
    }
    if (deleted && !existing) return { identity: undefined, appended: false, deleted: true };
    const event: PersonaVoiceIdentityEvent = {
      schemaVersion: 1,
      id: `voice-identity-event-${randomUUID()}`,
      ...next,
      supersedes: (state?.heads ?? []).map(item => item.id).sort(),
      deleted: deleted || undefined
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return { identity: deleted ? undefined : next, appended: true, deleted };
  });
}
