/**
 * Time source. Inject `CLOCK` instead of calling `new Date()` in domain code so expiry and
 * SLA logic can be tested with a fixed clock (spec section 12).
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
