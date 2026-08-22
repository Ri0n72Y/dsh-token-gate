import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import * as tokenGate from '../src/index.ts'
import type { Config } from '../src/config.ts'

const TOKEN = 'test-token-0123456789abcdef'
function config(port: number): Config { return { token: TOKEN, cookieName: 'dsh_session', sessionTtlDays: 30, sessionMax: 64, rateMax: 10, rateWindowMinutes: 15, rateMaxKeys: 64, allowIps: [], trustedProxies: [], trustedHosts: [], realIpHeader: 'x-forwarded-for', allowGeneratedToken: false, bind: '127.0.0.1', port } }
const logger = { info() {}, warn() {}, error() {} }

class TestWebServer extends Service {
  readonly host = '127.0.0.1' as const
  readonly port: number
  constructor(ctx: Context, port: number) {
    super(ctx, 'webServer')
    this.port = port
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: TestWebServer
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

test('plugin refuses a non-loopback DSH upstream', async () => {
  const ctx = { get(name: string) { return name === 'webServer' ? { host: '0.0.0.0', port: 3080 } : undefined }, effect() { throw new Error('effect should not run') }, logger } as unknown as Context
  await assert.rejects(tokenGate.apply(ctx, config(0)), /upstream webServer must bind to 127\.0\.0\.1/)
})

test('Cordis effect observes listen failures instead of logging-and-continuing', async () => {
  const occupied = createServer()
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  const port = (occupied.address() as AddressInfo).port
  try {
    const ctx = { get(name: string) { return name === 'webServer' ? { host: '127.0.0.1', port: 3080 } : undefined }, async effect(factory: () => unknown | Promise<unknown>) { await factory() }, logger } as unknown as Context
    await assert.rejects(tokenGate.apply(ctx, config(port)), /EADDRINUSE/)
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
})

test('Cordis effect returns an awaited gateway disposer', async () => {
  let disposer: (() => void | Promise<void>) | undefined
  const ctx = { get(name: string) { return name === 'webServer' ? { host: '127.0.0.1', port: 3080 } : undefined }, async effect(factory: () => unknown | Promise<unknown>) { const value = await factory(); if (typeof value === 'function') disposer = value as () => void | Promise<void> }, logger } as unknown as Context
  await tokenGate.apply(ctx, config(0))
  assert.ok(disposer)
  await disposer()
})

test('real Cordis disposal waits for an active client socket and releases the gateway port', { timeout: 5000 }, async () => {
  const upstream = createServer((_req, res) => res.end('ok'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const gatewayPort = await reservePort()
  const ctx = new Context()
  const provider = ctx.plugin({
    name: 'test-web-server',
    apply(child: Context) { new TestWebServer(child, upstreamPort) },
  })
  await provider

  let client: Socket | undefined
  try {
    const fiber = ctx.plugin(tokenGate, config(gatewayPort))
    await fiber

    let clientClosed = false
    client = connect(gatewayPort, '127.0.0.1')
    client.on('close', () => { clientClosed = true })
    await new Promise<void>((resolve, reject) => {
      client?.once('connect', resolve)
      client?.once('error', reject)
    })

    await fiber.dispose()
    assert.equal(clientClosed, true)

    const remounted = ctx.plugin(tokenGate, config(gatewayPort))
    await remounted
    await remounted.dispose()
  } finally {
    client?.destroy()
    await provider.dispose()
    await ctx.fiber.dispose()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
