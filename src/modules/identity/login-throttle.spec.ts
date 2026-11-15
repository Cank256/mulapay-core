import { describe, expect, it } from 'vitest';
import { lockoutMinutes, normaliseEmail } from './login-throttle';

describe('progressive lockout (spec 8.3)', () => {
  it('locks for 1, 2, 5, 15 then 60 minutes from the fifth failure', () => {
    expect([1, 2, 3, 4].map(lockoutMinutes)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 50].map(lockoutMinutes)).toEqual([1, 2, 5, 15, 60, 60, 60]);
  });

  it('normalises emails so case and spacing do not split the counter', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});
