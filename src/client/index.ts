import { createElement as h, useEffect, useState } from 'react'

interface PendingDevice {
  id: string
  authority: string
  browser?: string
  requestedAt: number
  expiresAt: number
  state: 'pending' | 'approved'
  approvedAt?: number
}

interface AuthorizedDevice {
  id: string
  authority: string
  browser?: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

interface Snapshot {
  pending: PendingDevice[]
  devices: AuthorizedDevice[]
}

interface Slots {
  inject(name: string, factory: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface ClientContext {
  slots: Slots
}

interface DeviceManagementApi {
  load(): Promise<Snapshot>
  approve(id: string): Promise<Snapshot>
  reject(id: string): Promise<Snapshot>
  revoke(id: string): Promise<Snapshot>
}

interface DeviceManagementTabProps {
  api: DeviceManagementApi
}

const BASE = '/__token-gate'

async function readJson(response: Response): Promise<Snapshot> {
  if (!response.ok) {
    throw new Error(response.status === 404
      ? 'Device management is available only from the host-local DSH Web.'
      : `Token Gate management request failed (${response.status}).`)
  }
  return await response.json() as Snapshot
}

function api(): DeviceManagementApi {
  const load = async (): Promise<Snapshot> => await readJson(await fetch(`${BASE}/devices`, {
    cache: 'no-store',
    credentials: 'same-origin',
  }))
  const action = async (path: string): Promise<Snapshot> => await readJson(await fetch(`${BASE}${path}`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }))
  return {
    load,
    approve: id => action(`/pending/${encodeURIComponent(id)}/approve`),
    reject: id => action(`/pending/${encodeURIComponent(id)}/reject`),
    revoke: id => action(`/devices/${encodeURIComponent(id)}/revoke`),
  }
}

function date(value: number): string {
  return new Date(value).toLocaleString()
}

function browser(value: string | undefined): string {
  return value === undefined ? 'Unknown browser' : value
}

function button(label: string, onClick: () => void): unknown {
  return h('button', { type: 'button', onClick, style: { marginRight: '0.5rem' } }, label)
}

function PendingRow({ item, act }: { item: PendingDevice; act: (kind: 'approve' | 'reject', id: string) => void }): unknown {
  const approved = item.state === 'approved'
  return h('li', { key: item.id, style: { marginBottom: '1rem' } },
    h('strong', null, browser(item.browser)),
    h('div', null, `Authority: ${item.authority}`),
    h('div', null, `Status: ${approved ? 'Approved — waiting for device' : 'Pending host approval'}`),
    h('div', null, `Requested: ${date(item.requestedAt)}`),
    approved && item.approvedAt !== undefined ? h('div', null, `Approved: ${date(item.approvedAt)}`) : null,
    h('div', null, `Expires: ${date(item.expiresAt)}`),
    h('div', { style: { marginTop: '0.4rem' } },
      approved
        ? button('Cancel approval', () => act('reject', item.id))
        : h('span', null,
            button('Approve', () => act('approve', item.id)),
            button('Reject', () => act('reject', item.id)),
          ),
    ),
  )
}

function DeviceRow({ item, act }: { item: AuthorizedDevice; act: (id: string) => void }): unknown {
  return h('li', { key: item.id, style: { marginBottom: '1rem' } },
    h('strong', null, browser(item.browser)),
    h('div', null, `Authority: ${item.authority}`),
    h('div', null, `Authorized: ${date(item.createdAt)}`),
    h('div', null, `Last durable activity: ${date(item.lastSeenAt)}`),
    h('div', null, `Session expires: ${date(item.expiresAt)}`),
    h('div', { style: { marginTop: '0.4rem' } }, button('Revoke', () => act(item.id))),
  )
}

function DeviceManagementTab({ api: management }: DeviceManagementTabProps): unknown {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    try {
      setSnapshot(await management.load())
      setError(undefined)
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const pendingAction = async (kind: 'approve' | 'reject', id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      setSnapshot(kind === 'approve' ? await management.approve(id) : await management.reject(id))
      setError(undefined)
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      setSnapshot(await management.revoke(id))
      setError(undefined)
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setBusy(false)
    }
  }

  if (error !== undefined) {
    return h('section', null,
      h('h2', null, 'Token Gate devices'),
      h('p', null, error),
      button('Retry', () => { void load() }),
    )
  }
  if (snapshot === undefined) return h('p', null, 'Loading Token Gate devices…')

  return h('section', null,
    h('h2', null, 'Token Gate devices'),
    h('p', null, 'Only devices approved here can reach this DSH instance through token-gate.'),
    h('h3', null, `Pending requests (${snapshot.pending.length})`),
    snapshot.pending.length === 0
      ? h('p', null, 'No pending device requests.')
      : h('ul', { style: { paddingLeft: '1.25rem' } }, ...snapshot.pending.map(item => h(PendingRow, {
        key: item.id,
        item,
        act: (kind: 'approve' | 'reject', id: string) => { void pendingAction(kind, id) },
      }))),
    h('h3', null, `Authorized devices (${snapshot.devices.length})`),
    snapshot.devices.length === 0
      ? h('p', null, 'No authorized devices.')
      : h('ul', { style: { paddingLeft: '1.25rem' } }, ...snapshot.devices.map(item => h(DeviceRow, {
        key: item.id,
        item,
        act: (id: string) => { void revoke(id) },
      }))),
    button('Refresh', () => { void load() }),
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const management = api()
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'token-gate-devices',
    order: 20,
    label: () => 'Token Gate',
    inject: () => ({ api: management }),
  }, DeviceManagementTab))
}
