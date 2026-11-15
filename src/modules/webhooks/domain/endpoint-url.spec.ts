import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import { isPrivateAddress, validateWebhookUrl } from './endpoint-url';

const PUBLIC = { allowPrivateNetworks: false };
const LOCAL = { allowPrivateNetworks: true };

function reason(url: string, policy = PUBLIC): string | undefined {
  try {
    validateWebhookUrl(url, policy);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).details?.reason as string;
  }
}

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1',
    'not-an-ip',
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '203.0.114.1',
    '2606:4700:4700::1111',
  ])('treats %s as public', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('validateWebhookUrl', () => {
  it('accepts a public https URL and normalises it', () => {
    expect(validateWebhookUrl('https://merchant.example.com/hooks/mulapay', PUBLIC)).toBe(
      'https://merchant.example.com/hooks/mulapay'
    );
    expect(validateWebhookUrl('https://merchant.example.com:8443/h?x=1', PUBLIC)).toContain(
      ':8443'
    );
  });
  it('requires https unless private networks are allowed', () => {
    expect(reason('http://merchant.example.com/hook')).toBe('https_required');
    expect(reason('ftp://merchant.example.com/hook')).toBe('https_required');
    expect(reason('http://127.0.0.1:3000/hook', LOCAL)).toBeUndefined();
    expect(reason('ftp://127.0.0.1/hook', LOCAL)).toBe('https_required');
  });
  it.each([
    ['https://127.0.0.1/hook', 'private_address'],
    ['https://[::1]/hook', 'private_address'],
    ['https://169.254.169.254/latest/meta-data', 'private_address'],
    ['https://10.0.0.5/hook', 'private_address'],
    ['https://2130706433/hook', 'private_address'],
    ['https://0x7f.0.0.1/hook', 'private_address'],
    ['https://[::ffff:7f00:1]/hook', 'private_address'],
    ['https://localhost/hook', 'private_address'],
    ['https://LOCALHOST/hook', 'private_address'],
    ['https://db.internal/hook', 'private_address'],
    ['https://printer.local/hook', 'private_address'],
    ['https://intranet/hook', 'private_address'],
    ['https://user:pass@merchant.example.com/hook', 'credentials_not_allowed'],
    ['https://merchant.example.com/hook#frag', 'fragment_not_allowed'],
    ['merchant.example.com/hook', 'not_a_url'],
    ['', 'not_a_url'],
  ])('rejects %s', (url, why) => {
    expect(reason(url)).toBe(why);
  });
  it('lets private addresses through only when allowed', () => {
    expect(reason('https://localhost/hook', LOCAL)).toBeUndefined();
    expect(reason('https://10.0.0.5/hook', LOCAL)).toBeUndefined();
  });
});
