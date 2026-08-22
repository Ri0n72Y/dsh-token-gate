import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { createAuthService } from '../src/auth.ts'
import { createAccessPolicy } from '../src/access.ts'
import type { Config } from '../src/config.ts'

const config: Config = {
  token: 'secret',
  cookieName: 'dsh_session',
  secureCookie: true,
  sessionTtlDays: 30,
  sessionMax: 16,
  rateMax: 10,
  rateWindowMinutes: 15,
  rateMaxKeys: 16,
  allowIps: [],
  trustedProxies: ['127.0.0.1/32'],
  trustedHosts: [],
  realIpHeader: 'x-forwarded-for',
  allowGeneratedToken: false,
  bind: '127.0.0.1',
  port: 3081,
}

function request(headers: Record<string, string>): IncomingMessage {
  return {
    url: '/?token=secret',
    method: 'GET',
    headers: {
      host: 'dsh.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.10',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

test('user-activated top-level cross-site navigation may bootstrap a valid share link', () => {
  const access = createAccessPolicy(config, createAuthService(config, 'secret'))
  const navigation = request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
  })
  assert.equal(access.decide(navigation), 'bootstrap')
})

test('cross-site bootstrap fetches, frames, and non-user navigations remain denied', () => {
  const access = createAccessPolicy(config, createAuthService(config, 'secret'))

  assert.equal(access.decide(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    origin: 'https://evil.example.com',
  })), 'deny')

  assert.equal(access.decide(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'iframe',
    'sec-fetch-user': '?1',
  })), 'deny')

  assert.equal(access.decide(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  })), 'deny')

  assert.equal(access.decide(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
    origin: 'https://evil.example.com',
  })), 'deny')
})
