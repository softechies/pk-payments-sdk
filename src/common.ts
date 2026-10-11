import { timingSafeEqual } from 'node:crypto';

export type Gateway = 'jazzcash' | 'easypaisa';

/**
 * One status vocabulary for both gateways.
 *   paid      money received, fulfil the order
 *   pending   waiting for the customer (wallet approval, voucher paid at a shop later)
 *   failed    declined, cancelled or expired
 *   unknown   the gateway didn't give a clear answer; check again with inquire()
 */
export type PaymentStatus = 'paid' | 'pending' | 'failed' | 'unknown';

export interface PaymentResult {
  gateway: Gateway;
  status: PaymentStatus;
  /** Your order / transaction reference. */
  orderId: string;
  /** Gateway response code, e.g. "000" (JazzCash) or "0000" (Easypaisa). */
  code: string;
  message: string;
  /** Gateway's own transaction id, when it returns one. */
  transactionId?: string;
  /** Amount in rupees, when the gateway reports it. */
  amount?: number;
  /** Untouched gateway response. Never send this to the browser: it can contain credentials. */
  raw: unknown;
}

export class PaymentError extends Error {
  readonly gateway: Gateway;
  readonly httpStatus: number | undefined;
  readonly raw: unknown;

  constructor(gateway: Gateway, message: string, options: { httpStatus?: number; raw?: unknown; cause?: unknown } = {}) {
    super(`[${gateway}] ${message}`, { cause: options.cause });
    this.name = 'PaymentError';
    this.gateway = gateway;
    this.httpStatus = options.httpStatus;
    this.raw = options.raw;
  }
}

export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export interface HttpOptions {
  /** Custom fetch, for tests or proxies. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Request timeout in ms. Default 60000: wallet charges wait for the customer to approve on their phone. */
  timeoutMs?: number;
}

/** Pakistan time (UTC+5, no daylight saving) regardless of the server's own timezone. */
export function pktParts(date: Date) {
  const shifted = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    yyyy: String(shifted.getUTCFullYear()),
    MM: pad(shifted.getUTCMonth() + 1),
    dd: pad(shifted.getUTCDate()),
    HH: pad(shifted.getUTCHours()),
    mm: pad(shifted.getUTCMinutes()),
    ss: pad(shifted.getUTCSeconds()),
  };
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

/** A form that posts itself on load. Return it as an HTML page to send the customer to the gateway. */
export function autoSubmitForm(action: string, fields: Record<string, string>, label = 'Continue to payment'): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n    ');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Redirecting to payment</title></head>
<body>
  <form id="pay" method="POST" action="${escapeHtml(action)}">
    ${inputs}
    <noscript><button type="submit">${escapeHtml(label)}</button></noscript>
  </form>
  <script>document.getElementById('pay').submit();</script>
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Accepts URLSearchParams, FormData or a plain object and returns string values. */
export function toRecord(input: URLSearchParams | FormData | Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (input instanceof URLSearchParams || (typeof FormData !== 'undefined' && input instanceof FormData)) {
    for (const [key, value] of (input as URLSearchParams).entries()) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

export async function postJson(
  gateway: Gateway,
  url: string,
  body: unknown,
  options: HttpOptions & { headers?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new PaymentError(gateway, timedOut ? 'Request timed out' : `Request failed: ${(error as Error).message}`, { cause: error });
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (!response.ok) {
    throw new PaymentError(gateway, `HTTP ${response.status}: ${text.slice(0, 200) || response.statusText}`, {
      httpStatus: response.status,
      raw: data ?? text,
    });
  }
  if (!data || typeof data !== 'object') {
    throw new PaymentError(gateway, `Expected JSON, got: ${text.slice(0, 120)}`, { httpStatus: response.status, raw: text });
  }
  return data as Record<string, unknown>;
}

export function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}
