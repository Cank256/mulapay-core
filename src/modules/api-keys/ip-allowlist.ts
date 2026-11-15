/**
 * API key IP allowlists (spec 6.11): single IPs or CIDR networks, IPv4 or IPv6.
 *
 * Entries are validated the way Postgres `cidr` validates them (no host bits set past
 * the prefix), so a bad entry is a 400 from validation, not a database error.
 */
import { BlockList, isIP } from 'node:net';

function toBigInt(address: string, family: 4 | 6): bigint {
  if (family === 4) {
    return address.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
  }
  const [head = '', tail = ''] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = address.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const groups = [
    ...headParts,
    ...Array<string>(address.includes('::') ? missing : 0).fill('0'),
    ...tailParts,
  ];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

/** True for `a.b.c.d`, `a.b.c.d/n` or IPv6 equivalents with no host bits set. */
export function isCidrEntry(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (!address || rest.length > 0) return false;
  const family = isIP(address);
  // IPv4-mapped and dotted IPv6 forms are refused to keep matching unambiguous.
  if (family === 0 || (family === 6 && address.includes('.'))) return false;
  const bits = family === 4 ? 32 : 128;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const length = Number(prefix);
  if (length < 1 || length > bits) return false;
  const hostMask = (1n << BigInt(bits - length)) - 1n;
  return (toBigInt(address, family === 4 ? 4 : 6) & hostMask) === 0n;
}

/** True when `ip` falls inside any entry; an empty or null allowlist allows every IP. */
export function ipAllowed(allowlist: readonly string[] | null, ip: string): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const family = isIP(ip);
  if (family === 0) return false;
  const list = new BlockList();
  for (const entry of allowlist) {
    const [address, prefix] = entry.split('/');
    if (!address) continue;
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    list.addSubnet(address, prefix ? Number(prefix) : type === 'ipv6' ? 128 : 32, type);
  }
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}
