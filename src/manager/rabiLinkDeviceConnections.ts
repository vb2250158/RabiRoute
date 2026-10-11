import path from 'node:path';
import { RabiLinkOwnerStore } from './rabiLinkOwnerStore.js';

type Connections = { version: 1; applicationOwner: string; devices: Record<string, string> };
export type ConnectionDirectory = { connectionOwnerDeviceId?: string; devices: { id: string; connectionTargetDeviceId: string }[] };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const failure = (code: string, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });

/** Cache of immutable connection assignments. Profiles and persona state remain in their PC owner. */
export class RabiLinkDeviceConnections {
  private readonly store: RabiLinkOwnerStore<Connections>;
  private readonly flights = new Map<string, Promise<Connections>>();
  constructor(private readonly options: { dataDir: string; scope(): string; readConnections(): Promise<ConnectionDirectory>; readOnly?: boolean }) {
    this.store = new RabiLinkOwnerStore<Connections>(path.join(options.dataDir, 'rabilink-connection-assignments'),
      () => ({ version: 1, applicationOwner: '', devices: {} }), value => {
        const stored = value as Connections;
        if (!stored || stored.version !== 1 || !stored.devices || typeof stored.devices !== 'object' || Array.isArray(stored.devices)
          || (stored.applicationOwner !== '' && !validId(stored.applicationOwner)) || Object.keys(stored.devices).length > 10000
          || Object.entries(stored.devices).some(([id, owner]) => !validId(id) || !validId(owner))) throw failure('CONNECTION_CACHE_INVALID');
        return stored;
      });
  }
  private scope() { const scope = this.options.scope(); if (!scope) throw failure('CONNECTION_DISABLED', 401); return scope; }
  private refresh(scope: string): Promise<Connections> {
    const previous = this.flights.get(scope); if (previous) return previous;
    const flight = (async () => {
      const directory = await this.options.readConnections();
      if (this.scope() !== scope) throw failure('CONNECTION_SCOPE_CHANGED', 401);
      if (!directory || !Array.isArray(directory.devices) || directory.devices.length > 10000) throw failure('CONNECTION_DIRECTORY_INVALID');
      const stored = this.store.read(scope), next = structuredClone(stored);
      if (directory.connectionOwnerDeviceId !== undefined && directory.connectionOwnerDeviceId !== '') {
        if (!validId(directory.connectionOwnerDeviceId)) throw failure('CONNECTION_DIRECTORY_INVALID');
        if (next.applicationOwner && next.applicationOwner !== directory.connectionOwnerDeviceId) throw failure('CONNECTION_OWNER_CHANGED', 409);
        next.applicationOwner = directory.connectionOwnerDeviceId;
      }
      for (const entry of directory.devices) {
        if (!validId(entry.id) || !validId(entry.connectionTargetDeviceId)) throw failure('CONNECTION_DIRECTORY_INVALID');
        if (Object.hasOwn(next.devices, entry.id) && next.devices[entry.id] !== entry.connectionTargetDeviceId) throw failure('CONNECTION_OWNER_CHANGED', 409);
        next.devices[entry.id] = entry.connectionTargetDeviceId;
      }
      if (this.options.readOnly && JSON.stringify(next) !== JSON.stringify(stored)) throw failure('MANAGER_READ_ONLY', 423);
      if (!this.options.readOnly && JSON.stringify(next) !== JSON.stringify(stored)) this.store.write(scope, next);
      return next;
    })();
    this.flights.set(scope, flight);
    void flight.finally(() => { if (this.flights.get(scope) === flight) this.flights.delete(scope); }).catch(() => {});
    return flight;
  }
  async deviceTarget(deviceId: string): Promise<string> {
    if (!validId(deviceId)) throw failure('CONNECTION_DEVICE_INVALID', 400);
    const scope = this.scope(), stored = this.store.read(scope);
    const current = Object.hasOwn(stored.devices, deviceId) ? stored : await this.refresh(scope);
    const owner = Object.hasOwn(current.devices, deviceId) ? current.devices[deviceId] : '';
    if (!owner) throw failure('CONNECTION_DEVICE_UNKNOWN', 404);
    return owner;
  }
  async applicationTarget(): Promise<string> {
    const scope = this.scope(), stored = this.store.read(scope);
    const owner = stored.applicationOwner || (await this.refresh(scope)).applicationOwner;
    if (!owner) throw failure('CONNECTION_APPLICATION_OWNER_UNKNOWN', 404);
    return owner;
  }
}
