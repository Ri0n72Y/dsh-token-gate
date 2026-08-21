import { BlockList, isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'

export function normalizeIp(input: string | undefined): string {
  if (input === undefined) return ''
  let value = input.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length)
    if (isIP(mapped) === 4) return mapped
  }
  return value
}

function parseEntry(entry: string): { address: string; prefix?: number; family: 4 | 6 } {
  const slash = entry.lastIndexOf('/')
  const rawAddress = slash === -1 ? entry : entry.slice(0, slash)
  const address = normalizeIp(rawAddress)
  const family = isIP(address)
  if (family !== 4 && family !== 6) throw new Error(`token-gate: invalid IP address: ${entry}`)
  if (slash === -1) return { address, family }
  const prefix = Number(entry.slice(slash + 1))
  const max = family === 4 ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new Error(`token-gate: invalid CIDR prefix: ${entry}`)
  }
  return { address, prefix, family }
}

export class IpSet {
  private readonly ipv4 = new BlockList()
  private readonly ipv6 = new BlockList()

  constructor(entries: readonly string[]) {
    for (const entry of entries) {
      const parsed = parseEntry(entry)
      const list = parsed.family === 4 ? this.ipv4 : this.ipv6
      const type = parsed.family === 4 ? 'ipv4' : 'ipv6'
      if (parsed.prefix === undefined) list.addAddress(parsed.address, type)
      else list.addSubnet(parsed.address, parsed.prefix, type)
    }
  }

  has(input: string | undefined): boolean {
    const address = normalizeIp(input)
    const family = isIP(address)
    if (family === 4) return this.ipv4.check(address, 'ipv4')
    if (family === 6) return this.ipv6.check(address, 'ipv6')
    return false
  }
}

export function isLoopbackIp(input: string | undefined): boolean {
  const address = normalizeIp(input)
  if (address === '::1') return true
  if (isIP(address) !== 4) return false
  return address.split('.')[0] === '127'
}

export function hostnameOf(authority: string): string {
  if (authority.length === 0) return ''
  if (authority[0] === '[') {
    const end = authority.indexOf(']')
    return (end === -1 ? authority : authority.slice(0, end + 1)).toLowerCase()
  }
  const colon = authority.lastIndexOf(':')
  if (colon === -1) return authority.toLowerCase()
  const port = authority.slice(colon + 1)
  if (/^\d+$/.test(port)) return authority.slice(0, colon).toLowerCase()
  return authority.toLowerCase()
}

export function isLoopbackHost(authority: string): boolean {
  const host = hostnameOf(authority)
  if (host === 'localhost' || host === '[::1]') return true
  const parts = host.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0]
  return undefined
}
