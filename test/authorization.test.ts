import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openAuthorizationRepository,
  type AuthorizedDeviceRecord,
  type PendingDeviceRecord,
  type StorageDomainFacility,
} from '../src/authorization.ts'
import { createAuthService } from '../src/auth.ts'
import type { Config } from '../src/config.ts'
import { createDeviceManagementService } from '../src/management.ts'
import { createPairingService } from '../src/pairing.ts'
import { createDeviceSessionService } from '../src/session.ts'
import { MemoryAuthorizationRepository } from './helpers.ts'

const TOKEN = 'test-token-0123456789abcdef'

function config(overrides: Partial<Config> = {}): Config {
  return {
    token: TOKEN,
    cookieName: 'dsh_session',
    pairingCookieName: 'dsh_pairing',
    sessionTtlDays: 30,
    renewalIntervalHours: 24,
    pendingTtlMinutes: 15,
    trustedProxies: [],
    allowGeneratedToken: false,
    bind: '127.0.0.1',
    port: 3081,
    ...overrides,
  }
}

test('pairing rejection, expiry and consumed state remain non-authorizing while host state is observable', async () => {
  const repository = new MemoryAuthorizationRepository()
  const auth = createAuthService(config({ pendingTtlMinutes: 1 }), TOKEN)
  let clock = 1_000
  const pairing = createPairingService(config({ pendingTtlMinutes: 1 }), auth, repository, () => clock)
  const management = createDeviceManagementService(repository)

  const rejected = await pairing.request('dsh.example.com', 'Browser A')
  assert.deepEqual(management.list().pending.map(item => item.state), ['pending'])
  assert.equal(await management.approve(rejected.id), true)
  const approvedView = management.list().pending[0]
  assert.equal(approvedView.state, 'approved')
  assert.equal(typeof approvedView.approvedAt, 'number')
  assert.equal(await management.reject(rejected.id), true)
  assert.deepEqual(await pairing.resolve(rejected.bearer, 'dsh.example.com'), { state: 'missing' })

  const expired = await pairing.request('dsh.example.com', 'Browser B')
  clock += 60_001
  assert.deepEqual(await pairing.resolve(expired.bearer, 'dsh.example.com'), { state: 'missing' })
  assert.equal(repository.getPending(expired.id), undefined)

  const consumed = await pairing.request('dsh.example.com', 'Browser C')
  assert.equal(await repository.consumePending(consumed.id), true)
  assert.deepEqual(await pairing.resolve(consumed.bearer, 'dsh.example.com'), { state: 'missing' })
})

test('device session rejects wrong authority and durable expiry', async () => {
  const cfg = config({ sessionTtlDays: 2, renewalIntervalHours: 24 })
  const repository = new MemoryAuthorizationRepository()
  const auth = createAuthService(cfg, TOKEN)
  let clock = 10_000
  const sessions = createDeviceSessionService(cfg, auth, repository, () => clock)
  const pairingBearer = 'pairing-for-authority-expiry'
  const pairingId = auth.digestBearer(pairingBearer)
  await repository.putPending(pairingId, {
    authority: 'dsh.example.com',
    requestedAt: clock,
    expiresAt: clock + 60_000,
    state: 'approved',
    approvedAt: clock,
  })
  const pending = repository.getPending(pairingId)
  assert.ok(pending)
  const issued = await sessions.issueApprovedSession(pairingBearer, pairingId, pending, false)

  assert.deepEqual(await sessions.validate(issued.bearer, 'other.example.com', false), { allowed: false })
  clock += 2 * 24 * 60 * 60 * 1000 + 1
  assert.deepEqual(await sessions.validate(issued.bearer, 'dsh.example.com', false), { allowed: false })
})

class TestTable<T> {
  readonly records = new Map<string, T>()
  private blocked?: {
    key: string
    entered: Promise<void>
    enter: () => void
    releasePromise: Promise<void>
    release: () => void
  }

  blockNextPut(key: string): { entered: Promise<void>; release: () => void } {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const releasePromise = new Promise<void>(resolve => { release = resolve })
    this.blocked = { key, entered, enter, releasePromise, release }
    return { entered, release }
  }

  get(key: string): T | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, T]> {
    return new Map(this.records).entries()
  }

  async put(key: string, value: T): Promise<void> {
    const blocked = this.blocked
    if (blocked?.key === key) {
      this.blocked = undefined
      blocked.enter()
      await blocked.releasePromise
    }
    this.records.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }

  async update(key: string, fn: (current: T) => T): Promise<T> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing key ${key}`)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

function repositoryFixture() {
  const pending = new TestTable<PendingDeviceRecord>()
  const devices = new TestTable<AuthorizedDeviceRecord>()
  const facility = {
    async open() {
      return {
        table(name: 'pending' | 'devices') {
          return name === 'pending' ? pending : devices
        },
        async close() {},
      }
    },
  } as unknown as StorageDomainFacility
  return { pending, devices, facility }
}

test('repository serializes session issue and renewal ahead of host revoke so revocation wins', async () => {
  const fixture = repositoryFixture()
  const repository = await openAuthorizationRepository(fixture.facility)

  const pairingId = 'pairing-1'
  const deviceId = 'device-1'
  await repository.putPending(pairingId, {
    authority: 'dsh.example.com',
    requestedAt: 1,
    expiresAt: 10_000,
    state: 'approved',
    approvedAt: 2,
  })
  const device: AuthorizedDeviceRecord = {
    authority: 'dsh.example.com',
    createdAt: 3,
    lastSeenAt: 3,
    expiresAt: 10_000,
    renewAfter: 5_000,
    pairingId,
  }

  const issueBarrier = fixture.devices.blockNextPut(deviceId)
  const issue = repository.issueDevice(pairingId, deviceId, device)
  await issueBarrier.entered
  const revokeDuringIssue = repository.revokeAuthorization(deviceId)
  issueBarrier.release()
  assert.ok(await issue)
  assert.equal(await revokeDuringIssue, true)
  assert.equal(repository.getDevice(deviceId), undefined)
  assert.equal(repository.getPending(pairingId), undefined)

  const pairingId2 = 'pairing-2'
  const deviceId2 = 'device-2'
  await repository.putPending(pairingId2, {
    authority: 'dsh.example.com',
    requestedAt: 20,
    expiresAt: 20_000,
    state: 'approved',
    approvedAt: 21,
  })
  const device2: AuthorizedDeviceRecord = { ...device, pairingId: pairingId2 }
  assert.ok(await repository.issueDevice(pairingId2, deviceId2, device2))

  const renewalBarrier = fixture.devices.blockNextPut(deviceId2)
  const renewal = repository.renewDevice(deviceId2, { ...device2, lastSeenAt: 100, expiresAt: 30_000 })
  await renewalBarrier.entered
  const revokeDuringRenewal = repository.revokeAuthorization(deviceId2)
  renewalBarrier.release()
  assert.equal(await renewal, true)
  assert.equal(await revokeDuringRenewal, true)
  assert.equal(repository.getDevice(deviceId2), undefined)
  assert.equal(repository.getPending(pairingId2), undefined)

  await repository.close()
})
