/**
 * Client address helpers shared by IP allowlists and rate limiting. The address itself comes
 * from `request.ip`, which Fastify derives from `TRUST_PROXY` only.
 */
import { isIPv6 } from 'node:net';

/**
 * The form an address is matched in: no IPv6 zone, and an IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.5`, what a dual-stack listener reports for an IPv4 client) as plain
 * IPv4, so an IPv4 allowlist entry matches the same client however the socket was opened.
 */
export function normalizeIp(ip: string): string {
  const withoutZone = ip.split('%')[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(withoutZone);
  return mapped?.[1] ?? withoutZone;
}

/** The part of an address that identifies a client: the address, or the /64 of an IPv6 one. */
export function clientSubject(rawIp: string): string {
  const ip = normalizeIp(rawIp);
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = ip.includes('::') && tail !== '' ? tail.split(':') : [];
  const missing = ip.includes('::') ? 8 - headGroups.length - tailGroups.length : 0;
  const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}
