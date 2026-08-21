/** dsh-token-gate — token bootstrap + session gateway for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import { resolveToken } from './config.ts'
import type { Config } from './config.ts'
import { createGateway } from './gateway.ts'

export const name = 'token-gate'
export { Config } from './config.ts'

export const inject = ['webServer']

interface TokenGateWebServer {
  readonly port: number
}

export function apply(ctx: Context, config: Config): void {
  const webServer = ctx.get('webServer') as TokenGateWebServer | undefined
  if (webServer === undefined) throw new Error('token-gate: webServer is unavailable')

  const token = resolveToken(config)
  if (token.source === 'generated') {
    ctx.logger.warn(`token-gate: generated temporary access token: ${token.value}`)
  } else {
    ctx.logger.info(`token-gate: access token loaded from ${token.source}`)
  }

  const upstream = { host: '127.0.0.1', port: webServer.port }
  const gateway = createGateway({ config, token: token.value, upstream, logger: ctx.logger })

  ctx.effect(() => {
    let disposed = false
    void gateway.listen().then(() => {
      if (disposed) {
        void gateway.close()
        return
      }
      ctx.logger.info(`token-gate: listening on ${config.bind}:${String(config.port)}, proxying to ${upstream.host}:${String(upstream.port)}`)
    }).catch((error) => {
      ctx.logger.error('token-gate: failed to listen: %s', String(error))
    })

    return () => {
      disposed = true
      void gateway.close()
    }
  }, 'token-gate: gateway server')
}
