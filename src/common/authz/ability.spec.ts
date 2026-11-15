import { describe, expect, it } from 'vitest';
import { abilityAllows, apiKeyAbility, merchantUserAbility, staffAbility } from './ability';
import { MERCHANT_PERMISSIONS, parsePermission, STAFF_PERMISSIONS } from './permissions';

describe('CASL abilities', () => {
  it('grants exactly the role permissions to merchant users', () => {
    const viewer = merchantUserAbility(['merchant:read', 'team:read']);
    expect(abilityAllows(viewer, 'merchant:read')).toBe(true);
    expect(abilityAllows(viewer, 'merchant:update')).toBe(false);
    expect(abilityAllows(viewer, 'api_keys:manage')).toBe(false);
  });

  it('treats manage as every action on the subject', () => {
    const admin = merchantUserAbility(['team:manage']);
    expect(abilityAllows(admin, 'team:read')).toBe(true);
    expect(abilityAllows(admin, 'api_keys:read')).toBe(false);
  });

  it('drops permissions of another actor type instead of granting them', () => {
    const merchantUser = merchantUserAbility([
      'merchants:create',
      'roles:manage',
      'payments:write',
    ]);
    expect(abilityAllows(merchantUser, 'merchants:create')).toBe(false);
    expect(abilityAllows(merchantUser, 'roles:manage')).toBe(false);
    const staff = staffAbility(['team:manage', 'merchants:read']);
    expect(abilityAllows(staff, 'team:manage')).toBe(false);
    expect(abilityAllows(staff, 'merchants:read')).toBe(true);
  });

  it('maps API key scopes and nothing else', () => {
    const key = apiKeyAbility(['payments:read', 'merchant:update']);
    expect(abilityAllows(key, 'payments:read')).toBe(true);
    expect(abilityAllows(key, 'payments:write')).toBe(false);
    expect(abilityAllows(key, 'merchant:update')).toBe(false);
  });

  it('every catalogue permission parses, and malformed keys throw', () => {
    for (const p of [...MERCHANT_PERMISSIONS, ...STAFF_PERMISSIONS]) {
      expect(parsePermission(p).subject.length).toBeGreaterThan(0);
    }
    expect(() => parsePermission('nope')).toThrow(/malformed/);
    expect(() => parsePermission('a:b:c')).toThrow(/malformed/);
  });
});
