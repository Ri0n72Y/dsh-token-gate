import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
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

function bootstrap(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: `/?token=${TOKEN}`, headers: { host: 'dsh.example.com' } }, (res) => {
      const cookies = res.headers['set-cookie']
      res.resume()
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 303)
          assert.ok(Array.isArray(cookies) && cookies.length > 0)
          resolve(cookies[0].split(';')[0])
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
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

test('real Cordis disposal waits for upgraded sockets and releases the gateway port', { timeout: 5000 }, async () => {
  const upstream = createServer()
  let upstreamSocket: Duplex | undefined
  upstream.on('upgrade', (_req, socket) => {
    upstreamSocket = socket
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
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
    const cookie = await bootstrap(gatewayPort)

    let clientClosed = false
    client = connect(gatewayPort, '127.0.0.1')
    client.on('close', () => { clientClosed = true })
    await new Promise<void>((resolve, reject) => {
      let raw = ''
      client?.once('connect', () => client?.write([
        'GET /api/events.mux HTTP/1.1',
        'Host: dsh.example.com',
        `Cookie: ${cookie}`,
        'Origin: http://dsh.example.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n')))
      client?.on('data', (chunk) => {
        raw += chunk.toString()
        if (raw.includes('\r\n\r\n')) {
          try {
            assert.match(raw, /^HTTP\/1\.1 101 /)
            resolve()
          } catch (error) {
            reject(error)
          }
        }
      })
      client?.once('error', reject)
    })

    await fiber.dispose()
    assert.equal(clientClosed, true)

    const remounted = ctx.plugin(tokenGate, config(gatewayPort))
    await remounted
    await remounted.dispose()
  } finally {
    client?.destroy()
    upstreamSocket?.destroy()
    await provider.dispose()
    await ctx.fiber.dispose()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
