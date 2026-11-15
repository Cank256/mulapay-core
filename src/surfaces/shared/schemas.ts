/** Request schema pieces shared by the dashboard and admin controllers. Strict by default. */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../common/auth/password-hasher';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { isCidrEntry } from '../../modules/api-keys/ip-allowlist';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** New passwords. Login accepts any string up to the maximum so the policy is not leaked. */
export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
export const passwordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

export const nameSchema = z.string().trim().min(1).max(200);
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'must be a 6-digit code');
export const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code');
export const currencySchema = z
  .string()
  .refine(isSupportedCurrency, 'must be a supported ISO 4217 currency');
export const mccSchema = z.string().regex(/^\d{4}$/, 'must be a 4-digit merchant category code');
export const websiteSchema = z.url({ protocol: /^https?$/ }).max(2048);
export const cidrSchema = z
  .string()
  .max(64)
  .refine(isCidrEntry, 'must be an IP address or CIDR network');

/** Spec 9.2 rule 12: metadata is capped at 20 keys and 4 KB. */
export const metadataSchema = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, 'at most 20 keys')
  .refine((m) => Buffer.byteLength(JSON.stringify(m)) <= 4096, 'at most 4 KB');

/** Public id path parameter. Unknown or malformed ids are a 404 from the lookup. */
export const refSchema = z.string().min(1).max(64);
export const refParamSchema = z.strictObject({ ref: refSchema });
export const idParamSchema = z.strictObject({ id: refSchema });

export const emptyBodySchema = z.strictObject({});
