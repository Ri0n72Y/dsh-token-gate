export type PendingState = 'pending' | 'approved'

export interface PendingDeviceRecord {
  authority: string
  browser?: string
  requestedAt: number
  expiresAt: number
  state: PendingState
  approvedAt?: number
  issuedDeviceId?: string
}

export interface AuthorizedDeviceRecord {
  authority: string
  browser?: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  renewAfter: number
  pairingId: string
}

interface ValueSchema<T> {
  parse(value: unknown): T
}

interface DomainSpec {
  name: string
  version: number
  tables: Record<string, { valueSchema: ValueSchema<unknown> }>
}

export interface KvTable<T> {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, fn: (current: T) => T): Promise<T>
}

interface AuthorizationDomain {
  table(name: 'pending'): KvTable<PendingDeviceRecord>
  table(name: 'devices'): KvTable<AuthorizedDeviceRecord>
  close(): Promise<void>
}

export interface StorageDomainFacility {
  open(spec: DomainSpec): Promise<AuthorizationDomain>
}

export interface AuthorizationRepository {
  getPending(id: string): PendingDeviceRecord | undefined
  listPending(now?: number): Array<{ id: string; record: PendingDeviceRecord }>
  putPending(id: string, record: PendingDeviceRecord): Promise<void>
  approvePending(id: string, now?: number): Promise<PendingDeviceRecord | undefined>
  rejectPending(id: string): Promise<boolean>
  consumePending(id: string): Promise<boolean>
  getDevice(id: string): AuthorizedDeviceRecord | undefined
  listDevices(now?: number): Array<{ id: string; record: AuthorizedDeviceRecord }>
  issueDevice(pairingId: string, deviceId: string, record: AuthorizedDeviceRecord): Promise<AuthorizedDeviceRecord | undefined>
  renewDevice(id: string, record: AuthorizedDeviceRecord): Promise<boolean>
  revokeAuthorization(deviceId: string): Promise<boolean>
  close(): Promise<void>
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`expected non-empty ${field}`)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return text(value, field)
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`expected ${field} timestamp`)
  return value
}

const pendingSchema: ValueSchema<PendingDeviceRecord> = {
  parse(value) {
    const raw = record(value)
    const state = raw.state
    if (state !== 'pending' && state !== 'approved') throw new Error('expected pending state')
    return {
      authority: text(raw.authority, 'authority'),
      browser: optionalText(raw.browser, 'browser'),
      requestedAt: timestamp(raw.requestedAt, 'requestedAt'),
      expiresAt: timestamp(raw.expiresAt, 'expiresAt'),
      state,
      approvedAt: raw.approvedAt === undefined ? undefined : timestamp(raw.approvedAt, 'approvedAt'),
      issuedDeviceId: optionalText(raw.issuedDeviceId, 'issuedDeviceId'),
    }
  },
}

const deviceSchema: ValueSchema<AuthorizedDeviceRecord> = {
  parse(value) {
    const raw = record(value)
    return {
      authority: text(raw.authority, 'authority'),
      browser: optionalText(raw.browser, 'browser'),
      createdAt: timestamp(raw.createdAt, 'createdAt'),
      lastSeenAt: timestamp(raw.lastSeenAt, 'lastSeenAt'),
      expiresAt: timestamp(raw.expiresAt, 'expiresAt'),
      renewAfter: timestamp(raw.renewAfter, 'renewAfter'),
      pairingId: text(raw.pairingId, 'pairingId'),
    }
  },
}

export const authorizationDomainSpec = {
  name: 'token-gate',
  version: 1,
  tables: {
    pending: { valueSchema: pendingSchema },
    devices: { valueSchema: deviceSchema },
  },
} satisfies DomainSpec

export async function openAuthorizationRepository(facility: StorageDomainFacility): Promise<AuthorizationRepository> {
  const domain = await facility.open(authorizationDomainSpec)
  const pending = domain.table('pending')
  const devices = domain.table('devices')
  let mutationTail: Promise<void> = Promise.resolve()

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(operation, operation)
    mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    getPending(id) {
      return pending.get(id)
    },

    listPending(now = Date.now()) {
      return [...pending.entries()]
        .filter(([, item]) => item.issuedDeviceId === undefined && item.expiresAt > now)
        .map(([id, item]) => ({ id, record: item }))
        .sort((a, b) => b.record.requestedAt - a.record.requestedAt)
    },

    putPending(id, item) {
      return pending.put(id, item)
    },

    approvePending(id, now = Date.now()) {
      return serialize(async () => {
        const current = pending.get(id)
        if (current === undefined || current.expiresAt <= now || current.issuedDeviceId !== undefined) return undefined
        if (current.state === 'approved') return current
        return await pending.update(id, item => ({ ...item, state: 'approved', approvedAt: now }))
      })
    },

    rejectPending(id) {
      return serialize(async () => {
        const current = pending.get(id)
        if (current === undefined || current.issuedDeviceId !== undefined) return false
        return await pending.delete(id)
      })
    },

    consumePending(id) {
      return serialize(() => pending.delete(id))
    },

    getDevice(id) {
      return devices.get(id)
    },

    listDevices(now = Date.now()) {
      return [...devices.entries()]
        .filter(([, item]) => item.expiresAt > now)
        .map(([id, item]) => ({ id, record: item }))
        .sort((a, b) => b.record.lastSeenAt - a.record.lastSeenAt)
    },

    issueDevice(pairingId, deviceId, item) {
      return serialize(async () => {
        const pairing = pending.get(pairingId)
        if (pairing === undefined || pairing.state !== 'approved') return undefined
        if (pairing.issuedDeviceId !== undefined && pairing.issuedDeviceId !== deviceId) return undefined

        const existing = devices.get(deviceId)
        if (existing !== undefined) {
          if (existing.pairingId !== pairingId || existing.authority !== item.authority) return undefined
        } else {
          await devices.put(deviceId, item)
        }
        if (pairing.issuedDeviceId === undefined) {
          await pending.put(pairingId, { ...pairing, issuedDeviceId: deviceId })
        }
        return devices.get(deviceId) ?? item
      })
    },

    renewDevice(id, item) {
      return serialize(async () => {
        const current = devices.get(id)
        if (current === undefined) return false
        if (current.pairingId !== item.pairingId || current.authority !== item.authority) return false
        await devices.put(id, item)
        return true
      })
    },

    revokeAuthorization(deviceId) {
      return serialize(async () => {
        const item = devices.get(deviceId)
        if (item === undefined) return false
        // Remove the pairing credential first so an approved exchange cannot
        // recreate the device after the durable revocation starts.
        await pending.delete(item.pairingId)
        return await devices.delete(deviceId)
      })
    },

    async close() {
      await mutationTail
      await domain.close()
    },
  }
}
