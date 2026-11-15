/**
 * Webhook URLs are merchant-controlled, so delivery is a server-side request to an address
 * the merchant chose: the classic SSRF. These rules apply twice, at registration and again
 * at delivery, because DNS can change in between.
 *
 *  - https only. `http` is allowed only where private networks are (local development and
 *    tests), because a plain-text webhook exposes the payload to the network.
 *  - no credentials, no fragment, a real host name.
 *  - the address must be public: loopback, private, link-local (including the cloud
 *    metadata address 169.254.169.254), carrier-grade NAT, multicast, reserved and
 *    documentation ranges are refused, for IPv4, IPv6 and IPv4-mapped IPv6.
 *
 * `WEBHOOK_ALLOW_PRIVATE_NETWORKS` lifts the address rule (and allows `http`). It is refused
 * by the environment schema in production.
 */
import { BlockList, isIP } from 'node:net';
import { AppError } from '../../../common/errors/app-error';

const PRIVATE_V4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const PRIVATE_V6: ReadonlyArray<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const blocked = new BlockList();
for (const [address, prefix] of PRIVATE_V4) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of PRIVATE_V6) blocked.addSubnet(address, prefix, 'ipv6');

/** True when connecting to `address` could reach a private, local or reserved network. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0] ?? address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
  const family = isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa'];

function reject(reason: string): never {
  throw new AppError('WEBHOOK_URL_REJECTED', { messageParams: { reason }, details: { reason } });
}

export interface WebhookUrlPolicy {
  /** Local development and tests only: allows http and private addresses. */
  readonly allowPrivateNetworks: boolean;
}

/** Returns the normalised URL, or throws WEBHOOK_URL_REJECTED with a short machine reason. */
export function validateWebhookUrl(raw: string, policy: WebhookUrlPolicy): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('not_a_url');
  }
  if (url.protocol !== 'https:' && !(policy.allowPrivateNetworks && url.protocol === 'http:')) {
    return reject('https_required');
  }
  if (url.username !== '' || url.password !== '') return reject('credentials_not_allowed');
  if (url.hash !== '') return reject('fragment_not_allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') return reject('host_required');
  if (!policy.allowPrivateNetworks) {
    if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return reject('private_address');
    }
    if (isIP(host) !== 0 && isPrivateAddress(host)) return reject('private_address');
    // A single-label name resolves through the local search domain, never the public DNS.
    if (isIP(host) === 0 && !host.includes('.')) return reject('private_address');
  }
  return url.toString();
}
