import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

const TOKEN = 'test-token-0123456789abcdef'
function config(port: number): Config { return { token: TOKEN, cookieName: 'dsh_session', secureCookie: true, sessionTtlDays: 30, sessionMax: 64, rateMax: 10, rateWindowMinutes: 15, rateMaxKeys: 64, allowIps: [], trustedProxies: [], trustedHosts: [], realIpHeader: 'x-forwarded-for', allowGeneratedToken: false, bind: '127.0.0.1', port } }
const logger = { info() {}, warn() {}, error() {} }

test('plugin refuses a non-loopback DSH upstream', async () => {
  const ctx = { get(name: string) { return name === 'webServer' ? { host: '0.0.0.0', port: 3080 } : undefined }, effect() { throw new Error('effect should not run') }, logger } as unknown as Context
  await assert.rejects(apply(ctx, config(0)), /upstream webServer must bind to 127\.0\.0\.1/)
})

test('Cordis effect observes listen failures instead of logging-and-continuing', async () => {
  const occupied = createServer()
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  const port = (occupied.address() as AddressInfo).port
  try {
    const ctx = { get(name: string) { return name === 'webServer' ? { host: '127.0.0.1', port: 3080 } : undefined }, async effect(factory: () => unknown | Promise<unknown>) { await factory() }, logger } as unknown as Context
    await assert.rejects(apply(ctx, config(port)), /EADDRINUSE/)
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
})

test('Cordis effect returns an awaited gateway disposer', async () => {
  let disposer: (() => void | Promise<void>) | undefined
  const ctx = { get(name: string) { return name === 'webServer' ? { host: '127.0.0.1', port: 3080 } : undefined }, async effect(factory: () => unknown | Promise<unknown>) { const value = await factory(); if (typeof value === 'function') disposer = value as () => void | Promise<void> }, logger } as unknown as Context
  await apply(ctx, config(0))
  assert.ok(disposer)
  await disposer()
})
