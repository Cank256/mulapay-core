import { describe, expect, it } from 'vitest';
import { sessionRefOfSecret } from './checkout-sessions.service';

describe('sessionRefOfSecret', () => {
  it('reads the session ref from the front of a client secret', () => {
    expect(sessionRefOfSecret('cs_01JBX7ABCDEFGHJKMNPQRSTVWX_secret_abc')).toBe(
      'cs_01JBX7ABCDEFGHJKMNPQRSTVWX'
    );
  });

  it('returns null for anything not shaped like a secret', () => {
    for (const value of ['', 'garbage', '_secret_abc', 'cs_x']) {
      expect(sessionRefOfSecret(value), value).toBeNull();
    }
  });
});
