import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

class TestWebServer extends Service {
  readonly host = '127.0.0.1' as const
  readonly port = 3080

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: TestWebServer
  }
}

const TOKEN = 'test-token-0123456789abcdef'

function config(port: number): Config {
  return {
    token: TOKEN,
    cookieName: 'dsh_session',
    secureCookie: true,
    sessionTtlDays: 30,
    sessionMax: 64,
    rateMax: 10,
    rateWindowMinutes: 15,
    rateMaxKeys: 64,
    allowIps: [],
    trustedProxies: [],
    trustedHosts: [],
    realIpHeader: 'x-forwarded-for',
    allowGeneratedToken: false,
    bind: '127.0.0.1',
    port,
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

test('real Cordis fiber activation owns and releases the gateway listener', async () => {
  const port = await freePort()
  const root = new Context()
  const webFiber = root.plugin(TestWebServer)
  await webFiber
  const gateFiber = root.plugin({
    name: 'token-gate-real-lifecycle',
    inject: ['webServer'],
    apply: (ctx: Context) => apply(ctx, config(port)),
  })
  await gateFiber
  assert.equal(gateFiber.state, FiberState.ACTIVE)

  await gateFiber.dispose()

  const rebound = createServer()
  await new Promise<void>((resolve, reject) => {
    rebound.once('error', reject)
    rebound.listen(port, '127.0.0.1', resolve)
  })
  await new Promise<void>(resolve => rebound.close(() => resolve()))
  await webFiber.dispose()
  await root.fiber.dispose()
})

test('real Cordis fiber reports listen acquisition failure', async () => {
  const occupied = createServer()
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  const port = (occupied.address() as AddressInfo).port

  const root = new Context()
  const webFiber = root.plugin(TestWebServer)
  await webFiber
  const gateFiber = root.plugin({
    name: 'token-gate-real-listen-failure',
    inject: ['webServer'],
    apply: (ctx: Context) => apply(ctx, config(port)),
  })
  await assert.rejects(gateFiber, /EADDRINUSE/)
  assert.equal(gateFiber.state, FiberState.FAILED)

  await new Promise<void>(resolve => occupied.close(() => resolve()))
  await webFiber.dispose()
  await root.fiber.dispose()
})
