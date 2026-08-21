import { randomBytes } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  token?: string
  cookieName: string
  sessionTtlDays: number
  rateMax: number
  rateWindowMinutes: number
  allowIps: string[]
  trustedProxies: string[]
  allowGeneratedToken: boolean
  bind: '0.0.0.0' | '127.0.0.1'
  port: number
}

export const Config: Schema<Config> = Schema.object({
  token: Schema.string(),
  cookieName: Schema.string().default('dsh_session'),
  sessionTtlDays: Schema.natural().min(1).max(365).default(30),
  rateMax: Schema.natural().min(1).default(10),
  rateWindowMinutes: Schema.natural().min(1).default(15),
  allowIps: Schema.array(String).default([]),
  trustedProxies: Schema.array(String).default(['127.0.0.0/8', '::1/128']),
  allowGeneratedToken: Schema.boolean().default(false),
  bind: Schema.union([Schema.const('0.0.0.0'), Schema.const('127.0.0.1')]).default('0.0.0.0'),
  port: Schema.natural().min(1).max(65535).default(3081),
})

export interface ResolvedToken {
  value: string
  source: 'config' | 'env' | 'generated'
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
