import { describe, expect, it } from 'vitest';
import { ipAllowed } from '../../modules/api-keys/ip-allowlist';
import { clientSubject, normalizeIp } from './client-ip';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 and drops zone ids', () => {
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('::FFFF:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('clientSubject', () => {
  it('is the address for IPv4, in whichever form the socket reports it', () => {
    expect(clientSubject('203.0.113.5')).toBe('203.0.113.5');
    expect(clientSubject('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });
  it('is the /64 for IPv6, so rotating the host part buys nothing', () => {
    const a = clientSubject('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(clientSubject('2001:db8:1:2::1')).toBe(a);
    expect(clientSubject('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(clientSubject('2001:db8:1:3::1')).not.toBe(a);
  });
  it('expands :: forms', () => {
    expect(clientSubject('::1')).toBe('0:0:0:0::/64');
    expect(clientSubject('2001:db8::')).toBe('2001:db8:0:0::/64');
  });
});

describe('ipAllowed with real-world address forms', () => {
  it('matches an IPv4 entry against a dual-stack socket address', () => {
    expect(ipAllowed(['203.0.113.0/24'], '::ffff:203.0.113.77')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '::ffff:203.0.114.77')).toBe(false);
  });
  it('matches IPv6 networks and single addresses', () => {
    expect(ipAllowed(['2001:db8::/32'], '2001:db8:aaaa::1')).toBe(true);
    expect(ipAllowed(['2001:db8::/32'], '2001:db9::1')).toBe(false);
    expect(ipAllowed(['2001:db8::1/128'], '2001:db8::1')).toBe(true);
    expect(ipAllowed(['2001:db8::1/128'], '2001:db8::2')).toBe(false);
  });
  it('refuses anything that is not an address, and everything when the list excludes it', () => {
    expect(ipAllowed(['203.0.113.0/24'], 'not-an-ip')).toBe(false);
    expect(ipAllowed(['203.0.113.0/24'], '')).toBe(false);
    expect(ipAllowed(['203.0.113.0/24'], '127.0.0.1')).toBe(false);
  });
  it('allows everyone when there is no allowlist', () => {
    expect(ipAllowed(null, '198.51.100.1')).toBe(true);
    expect(ipAllowed([], '198.51.100.1')).toBe(true);
  });
});
