import type { UpstreamTarget } from './proxy.ts'

export interface WebServerInfo {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
}

export function resolveUpstream(webServer: WebServerInfo): UpstreamTarget {
  if (webServer.host !== '127.0.0.1') {
    throw new Error('token-gate: upstream webServer must bind to 127.0.0.1')
  }
  return { host: '127.0.0.1', port: webServer.port }
}
