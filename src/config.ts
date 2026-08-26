import { randomBytes } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  token?: string
  cookieName: string
  pairingCookieName: string
  sessionTtlDays: number
  renewalIntervalHours: number
  pendingTtlMinutes: number
  trustedProxies: string[]
  allowGeneratedToken: boolean
  bind: '0.0.0.0' | '127.0.0.1'
  port: number
}

export const Config: Schema<Config> = Schema.object({
  token: Schema.string(),
  cookieName: Schema.string().default('dsh_session'),
  pairingCookieName: Schema.string().default('dsh_pairing'),
  sessionTtlDays: Schema.natural().min(1).max(365).default(30),
  renewalIntervalHours: Schema.natural().min(1).max(720).default(24),
  pendingTtlMinutes: Schema.natural().min(1).max(1440).default(15),
  trustedProxies: Schema.array(String).default([]),
  allowGeneratedToken: Schema.boolean().default(false),
  bind: Schema.union([Schema.const('0.0.0.0'), Schema.const('127.0.0.1')]).default('127.0.0.1'),
  port: Schema.natural().min(1).max(65535).default(3081),
})

export interface ResolvedToken {
  value: string
  source: 'config' | 'env' | 'generated'
}

export function validateConfig(config: Config): void {
  if (config.cookieName === config.pairingCookieName) {
    throw new Error('token-gate: session and pairing cookie names must differ')
  }
  if (config.renewalIntervalHours * 60 * 60 * 1000 >= config.sessionTtlDays * 24 * 60 * 60 * 1000) {
    throw new Error('token-gate: renewalIntervalHours must be shorter than sessionTtlDays')
  }
}

export function resolveToken(config: Config): ResolvedToken {
  if (config.token !== undefined && config.token.length > 0) {
    return { value: config.token, source: 'config' }
  }
  const env = process.env.DSH_AUTH_TOKEN
  if (env !== undefined && env.length > 0) {
    return { value: env, source: 'env' }
  }
  if (config.allowGeneratedToken) {
    return { value: randomBytes(32).toString('base64url'), source: 'generated' }
  }
  throw new Error('token-gate: no access token configured; set config.token or DSH_AUTH_TOKEN')
}
