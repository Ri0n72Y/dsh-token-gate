/** dsh-token-gate — token bootstrap + session gateway for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import { resolveToken } from './config.ts'
import type { Config } from './config.ts'
import { createGateway } from './gateway.ts'
import { resolveUpstream } from './upstream.ts'

export const name = 'token-gate'
export { Config } from './config.ts'
export const inject = ['webServer']

interface TokenGateWebServer {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const webServer = ctx.get('webServer') as TokenGateWebServer | undefined
  if (webServer === undefined) throw new Error('token-gate: webServer is unavailable')
  const upstream = resolveUpstream(webServer)
  const token = resolveToken(config)
  if (token.source === 'generated') ctx.logger.warn(`token-gate: generated temporary access token: ${token.value}`)
  else ctx.logger.info(`token-gate: access token loaded from ${token.source}`)
  const gateway = createGateway({ config, token: token.value, upstream, logger: ctx.logger })
  await ctx.effect(async () => {
    await gateway.listen()
    ctx.logger.info(`token-gate: listening on ${config.bind}:${String(config.port)}, proxying to ${upstream.host}:${String(upstream.port)}`)
    return async () => { await gateway.close() }
  }, 'token-gate: gateway server')
}
