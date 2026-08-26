import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { createAccessPolicy } from '../src/access.ts'
import { normalizeIp } from '../src/net.ts'
import { resolveUpstream } from '../src/upstream.ts'
import { resolveToken, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'

const baseConfig: Config = {
  token: 'secret',
  cookieName: 'dsh_session',
  pairingCookieName: 'dsh_pairing',
  sessionTtlDays: 30,
  renewalIntervalHours: 24,
  pendingTtlMinutes: 15,
  trustedProxies: [],
  allowGeneratedToken: false,
  bind: '127.0.0.1',
  port: 3081,
}

function fakeReq(host: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    url: '/',
    method: 'GET',
    headers: { host },
    socket: { remoteAddress: '203.0.113.10' },
    ...extra,
  } as unknown as IncomingMessage
}

test('socket address normalization handles IPv4-mapped loopback', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIp('[::1]'), '::1')
})

test('DSH upstream must remain loopback-only', () => {
  assert.deepEqual(resolveUpstream({ host: '127.0.0.1', port: 3080 }), { host: '127.0.0.1', port: 3080 })
  assert.throws(() => resolveUpstream({ host: '0.0.0.0', port: 3080 }), /must bind to 127\.0\.0\.1/)
})

test('pairing owns only the root token query and preserves the clean return route', () => {
  const access = createAccessPolicy(baseConfig)
  const root = fakeReq('dsh.example.com', { url: '/?x=1&token=secret&y=2' })
  assert.equal(access.bootstrapToken(root), 'secret')
  assert.equal(access.cleanBootstrapLocation(root), '/?x=1&y=2')

  const appPath = fakeReq('dsh.example.com', { url: '/chat?token=app-value' })
  assert.equal(access.bootstrapToken(appPath), undefined)
  assert.equal(access.isBrowserTrusted(appPath), true)

  const crossSite = fakeReq('dsh.example.com', {
    headers: { host: 'dsh.example.com', origin: 'https://attacker.example' },
  })
  assert.equal(access.isBrowserTrusted(crossSite), false)
})

test('device-session configuration rejects ambiguous cookies and impossible renewal intervals', () => {
  assert.doesNotThrow(() => validateConfig(baseConfig))
  assert.throws(
    () => validateConfig({ ...baseConfig, pairingCookieName: baseConfig.cookieName }),
    /cookie names must differ/,
  )
  assert.throws(
    () => validateConfig({ ...baseConfig, sessionTtlDays: 1, renewalIntervalHours: 24 }),
    /must be shorter than sessionTtlDays/,
  )
})

test('token resolution covers configured, environment, generated, and missing tokens', () => {
  const original = process.env.DSH_AUTH_TOKEN
  try {
    process.env.DSH_AUTH_TOKEN = 'env-secret'
    assert.deepEqual(resolveToken({ ...baseConfig, token: 'config-secret' }), { value: 'config-secret', source: 'config' })
    assert.deepEqual(resolveToken({ ...baseConfig, token: undefined }), { value: 'env-secret', source: 'env' })
    delete process.env.DSH_AUTH_TOKEN
    const generated = resolveToken({ ...baseConfig, token: undefined, allowGeneratedToken: true })
    assert.equal(generated.source, 'generated')
    assert.ok(generated.value.length >= 40)
    assert.throws(() => resolveToken({ ...baseConfig, token: undefined, allowGeneratedToken: false }), /no access token configured/)
  } finally {
    if (original === undefined) delete process.env.DSH_AUTH_TOKEN
    else process.env.DSH_AUTH_TOKEN = original
  }
})
