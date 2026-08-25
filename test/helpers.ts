import type {
  AuthorizationRepository,
  AuthorizedDeviceRecord,
  PendingDeviceRecord,
} from '../src/authorization.ts'

export interface AuthorizationState {
  pending: Map<string, PendingDeviceRecord>
  devices: Map<string, AuthorizedDeviceRecord>
}

export function authorizationState(): AuthorizationState {
  return { pending: new Map(), devices: new Map() }
}

export class MemoryAuthorizationRepository implements AuthorizationRepository {
  renewWrites = 0

  constructor(readonly state: AuthorizationState = authorizationState()) {}

  getPending(id: string): PendingDeviceRecord | undefined {
    return this.state.pending.get(id)
  }

  listPending(now = Date.now()) {
    return [...this.state.pending.entries()]
      .filter(([, item]) => item.state === 'pending' && item.expiresAt > now)
      .map(([id, record]) => ({ id, record }))
      .sort((a, b) => b.record.requestedAt - a.record.requestedAt)
  }

  async putPending(id: string, record: PendingDeviceRecord): Promise<void> {
    this.state.pending.set(id, record)
  }

  async approvePending(id: string, now = Date.now()): Promise<PendingDeviceRecord | undefined> {
    const current = this.state.pending.get(id)
    if (current === undefined || current.expiresAt <= now) return undefined
    if (current.state === 'approved') return current
    const next = { ...current, state: 'approved' as const, approvedAt: now }
    this.state.pending.set(id, next)
    return next
  }

  async markPendingIssued(id: string, deviceId: string): Promise<PendingDeviceRecord | undefined> {
    const current = this.state.pending.get(id)
    if (current === undefined || current.state !== 'approved') return undefined
    if (current.issuedDeviceId !== undefined && current.issuedDeviceId !== deviceId) return undefined
    const next = { ...current, issuedDeviceId: deviceId }
    this.state.pending.set(id, next)
    return next
  }

  async rejectPending(id: string): Promise<boolean> {
    return this.state.pending.delete(id)
  }

  async consumePending(id: string): Promise<boolean> {
    return this.state.pending.delete(id)
  }

  getDevice(id: string): AuthorizedDeviceRecord | undefined {
    return this.state.devices.get(id)
  }

  listDevices(now = Date.now()) {
    return [...this.state.devices.entries()]
      .filter(([, item]) => item.expiresAt > now)
      .map(([id, record]) => ({ id, record }))
      .sort((a, b) => b.record.lastSeenAt - a.record.lastSeenAt)
  }

  async putDevice(id: string, record: AuthorizedDeviceRecord): Promise<void> {
    this.state.devices.set(id, record)
  }

  async renewDevice(id: string, record: AuthorizedDeviceRecord): Promise<void> {
    this.renewWrites += 1
    this.state.devices.set(id, record)
  }

  async revokeDevice(id: string): Promise<boolean> {
    return this.state.devices.delete(id)
  }

  async close(): Promise<void> {}
}
