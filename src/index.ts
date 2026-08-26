/** dsh-token-gate — host-approved device gateway for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { openAuthorizationRepository } from './authorization.ts'
import type { StorageDomainFacility } from './authorization.ts'
import { resolveToken, validateConfig } from './config.ts'
import type { Config } from './config.ts'
import { createGateway } from './gateway.ts'
import { createDeviceManagementService, registerManagementRoutes } from './management.ts'
import { resolveUpstream } from './upstream.ts'

export const name = 'token-gate'
export { Config } from './config.ts'
export const inject = ['webServer', 'storageDomain']

interface TokenGateWebServer {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  validateConfig(config)
  const webServer = ctx.get('webServer') as TokenGateWebServer | undefined
  if (webServer === undefined) throw new Error('token-gate: webServer is unavailable')
  const storageDomain = ctx.get('storageDomain') as StorageDomainFacility | undefined
  if (storageDomain === undefined) throw new Error('token-gate: storageDomain is unavailable')

  const upstream = resolveUpstream(webServer)
  const token = resolveToken(config)
  if (token.source === 'generated') ctx.logger.warn(`token-gate: generated temporary access token: ${token.value}`)
  else ctx.logger.info(`token-gate: bootstrap token loaded from ${token.source}`)

  await ctx.effect(async () => {
    const repository = await openAuthorizationRepository(storageDomain)
    let unregisterManagement: (() => void) | undefined
    let gateway: ReturnType<typeof createGateway> | undefined
    try {
      const management = createDeviceManagementService(repository)
      unregisterManagement = registerManagementRoutes(webServer, management)
      gateway = createGateway({
        config,
        token: token.value,
        upstream,
        repository,
        logger: ctx.logger,
      })
      await gateway.listen()
    } catch (error) {
      unregisterManagement?.()
      await repository.close()
      throw error
    }

    ctx.logger.info(
      `token-gate: listening on ${config.bind}:${String(config.port)}, proxying approved devices to ${upstream.host}:${String(upstream.port)}`,
    )

    return async () => {
      await gateway?.close()
      unregisterManagement?.()
      await repository.close()
    }
  }, 'token-gate: authorization gateway')
}
