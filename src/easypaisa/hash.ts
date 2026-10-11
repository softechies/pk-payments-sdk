import { createCipheriv } from 'node:crypto';
import { ValidationError } from '../common.js';

/** Fields that go into merchantHashedReq, in the order Easypaisa expects (alphabetical). */
export const EASYPAISA_HASH_FIELDS = [
  'amount',
  'autoRedirect',
  'emailAddr',
  'expiryDate',
  'mobileNum',
  'orderRefNum',
  'paymentMethod',
  'postBackURL',
  'storeId',
] as const;

/**
 * merchantHashedReq for the Easypay hosted checkout:
 *   "amount=10.0&autoRedirect=1&...&storeId=123" (empty fields left out),
 *   AES/ECB/PKCS5 with the hash key from the merchant portal (16, 24 or 32 characters), base64.
 */
export function easypaisaHashedRequest(fields: Record<string, string>, hashKey: string): string {
  const key = Buffer.from(hashKey, 'utf8');
  if (![16, 24, 32].includes(key.length)) {
    throw new ValidationError('hashKey', 'must be 16, 24 or 32 characters');
  }

  const message = EASYPAISA_HASH_FIELDS.filter((name) => fields[name] !== undefined && fields[name] !== '')
    .map((name) => `${name}=${fields[name]}`)
    .join('&');

  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([cipher.update(message, 'utf8'), cipher.final()]).toString('base64');
}
