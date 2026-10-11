import { createHmac } from 'node:crypto';
import { ValidationError, safeEqual } from '../common.js';

/**
 * JazzCash secure hash:
 *   1. take every field whose name starts with "pp" (pp_ and ppmpf_), except pp_SecureHash
 *   2. drop empty values
 *   3. sort by field name
 *   4. join the values with "&" and put the integrity salt in front: salt&v1&v2&...
 *   5. HMAC-SHA256 with the integrity salt as the key, text encoded as ISO-8859-1
 *   6. hex, upper case
 */
export function jazzCashSecureHash(fields: Record<string, string>, integritySalt: string): string {
  const salt = integritySalt.trim();
  const values = Object.keys(fields)
    .filter((key) => key.toLowerCase().startsWith('pp') && key !== 'pp_SecureHash')
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .sort()
    .map((key) => String(fields[key]));

  const message = [salt, ...values].join('&');
  assertLatin1('fields', message);
  return createHmac('sha256', Buffer.from(salt, 'latin1')).update(message, 'latin1').digest('hex').toUpperCase();
}

export function verifyJazzCashHash(fields: Record<string, string>, integritySalt: string): boolean {
  const received = fields.pp_SecureHash;
  if (!received) return false;
  return safeEqual(jazzCashSecureHash(fields, integritySalt), received.toUpperCase());
}

/** JazzCash signs ISO-8859-1. Anything outside it (e.g. Urdu) produces a hash the gateway rejects. */
export function assertLatin1(field: string, value: string): void {
  if ([...value].some((ch) => ch.charCodeAt(0) > 0xff)) {
    throw new ValidationError(field, 'contains characters JazzCash cannot sign (use English text only)');
  }
}
