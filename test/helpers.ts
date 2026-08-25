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
  readonly state: AuthorizationState

  constructor(state: AuthorizationState = authorizationState()) {
    this.state = state
  }

  getPending(id: string): PendingDeviceRecord | undefined {
    return this.state.pending.get(id)
  }

  listPending(now = Date.now()) {
    return [...this.state.pending.entries()]
      .filter(([, item]) => item.issuedDeviceId === undefined && item.expiresAt > now)
      .map(([id, record]) => ({ id, record }))
      .sort((a, b) => b.record.requestedAt - a.record.requestedAt)
  }

  async putPending(id: string, record: PendingDeviceRecord): Promise<void> {
    this.state.pending.set(id, record)
  }

  async approvePending(id: string, now = Date.now()): Promise<PendingDeviceRecord | undefined> {
    const current = this.state.pending.get(id)
    if (current === undefined || current.expiresAt <= now || current.issuedDeviceId !== undefined) return undefined
    if (current.state === 'approved') return current
    const next = { ...current, state: 'approved' as const, approvedAt: now }
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

  async issueDevice(pairingId: string, deviceId: string, record: AuthorizedDeviceRecord): Promise<AuthorizedDeviceRecord | undefined> {
    const pairing = this.state.pending.get(pairingId)
    if (pairing === undefined || pairing.state !== 'approved') return undefined
    if (pairing.issuedDeviceId !== undefined && pairing.issuedDeviceId !== deviceId) return undefined
    const existing = this.state.devices.get(deviceId)
    if (existing !== undefined) {
      if (existing.pairingId !== pairingId || existing.authority !== record.authority) return undefined
    } else {
      this.state.devices.set(deviceId, record)
    }
    if (pairing.issuedDeviceId === undefined) {
      this.state.pending.set(pairingId, { ...pairing, issuedDeviceId: deviceId })
    }
    return this.state.devices.get(deviceId) ?? record
  }

  async renewDevice(id: string, record: AuthorizedDeviceRecord): Promise<boolean> {
    const current = this.state.devices.get(id)
    if (current === undefined) return false
    if (current.pairingId !== record.pairingId || current.authority !== record.authority) return false
    this.renewWrites += 1
    this.state.devices.set(id, record)
    return true
  }

  async revokeAuthorization(deviceId: string): Promise<boolean> {
    const item = this.state.devices.get(deviceId)
    if (item === undefined) return false
    this.state.pending.delete(item.pairingId)
    return this.state.devices.delete(deviceId)
  }

  async close(): Promise<void> {}
}
