import {
  type HttpOptions,
  type PaymentResult,
  type PaymentStatus,
  PaymentError,
  ValidationError,
  addHours,
  autoSubmitForm,
  pktParts,
  postJson,
  str,
  toRecord,
} from '../common.js';
import { easypaisaHashedRequest } from './hash.js';

export interface EasypaisaOptions extends HttpOptions {
  storeId: string;
  /** Hash key from the Easypay merchant portal. Needed for the hosted checkout. */
  hashKey?: string;
  /** API username and password from Easypaisa. Needed for the REST calls (wallet, voucher, inquiry). */
  username?: string;
  password?: string;
  /** Your merchant account number. Needed for inquire(). */
  accountNumber?: string;
  environment?: 'sandbox' | 'live';
  baseUrl?: string;
}

export type EasypaisaMethod = 'MA_PAYMENT_METHOD' | 'OTC_PAYMENT_METHOD' | 'CC_PAYMENT_METHOD';

export interface EasypaisaCheckoutInput {
  /** Amount in rupees. */
  amount: number;
  orderId: string;
  /** Your page that receives the auth_token, then the final result. */
  postBackUrl: string;
  /** Limit the page to one method. Left out: the customer chooses. */
  paymentMethod?: EasypaisaMethod;
  email?: string;
  /** 03XXXXXXXXX, pre-fills the wallet number. */
  mobile?: string;
  /** Default 24 hours. */
  expiresInHours?: number;
  /** Send the customer back to postBackUrl automatically after paying. Default true. */
  autoRedirect?: boolean;
  now?: Date;
}

export interface EasypaisaCheckout {
  url: string;
  fields: Record<string, string>;
  html: string;
}

export interface EasypaisaWalletInput {
  amount: number;
  orderId: string;
  /** Customer's Easypaisa account, 03XXXXXXXXX. */
  mobile: string;
  email: string;
}

export interface EasypaisaVoucherInput {
  amount: number;
  orderId: string;
  mobile: string;
  email: string;
  /** How long the voucher can be paid at a shop. Default 72 hours. */
  expiresInHours?: number;
  now?: Date;
}

export interface EasypaisaVoucher extends PaymentResult {
  /** Code the customer gives at an Easypaisa shop. */
  paymentToken?: string;
}

const HOSTS = {
  sandbox: 'https://easypaystg.easypaisa.com.pk',
  live: 'https://easypay.easypaisa.com.pk',
};

/** Hosts Easypaisa IPN links may point to. Anything else is refused. */
const IPN_HOST = /(^|\.)easypaisa\.com\.pk$/i;

const INQUIRY_STATUS: Record<string, PaymentStatus> = {
  PAID: 'paid',
  PENDING: 'pending',
  FAILED: 'failed',
  BLOCKED: 'failed',
  EXPIRED: 'failed',
  REVERSED: 'failed',
};

export class EasypaisaClient {
  private readonly base: string;

  constructor(private readonly options: EasypaisaOptions) {
    if (!options.storeId) throw new ValidationError('storeId', 'is required');
    this.base = (options.baseUrl ?? HOSTS[options.environment ?? 'sandbox']).replace(/\/$/, '');
  }

  /**
   * Step 1 of the hosted checkout. Easypaisa answers by redirecting the customer to
   * postBackUrl?auth_token=... and you continue with confirmCheckout().
   */
  createCheckout(input: EasypaisaCheckoutInput): EasypaisaCheckout {
    if (!this.options.hashKey) throw new ValidationError('hashKey', 'is required for the hosted checkout');
    orderId(input.orderId);

    const now = input.now ?? new Date();
    const fields: Record<string, string> = {
      storeId: this.options.storeId,
      amount: formatAmount(input.amount),
      postBackURL: input.postBackUrl,
      orderRefNum: input.orderId,
      expiryDate: formatExpiry(addHours(now, input.expiresInHours ?? 24)),
      autoRedirect: input.autoRedirect === false ? '0' : '1',
      paymentMethod: input.paymentMethod ?? '',
      emailAddr: input.email ?? '',
      mobileNum: input.mobile ?? '',
    };
    if (fields.mobileNum && !/^03\d{9}$/.test(fields.mobileNum)) throw new ValidationError('mobile', 'must be 03XXXXXXXXX');
    fields.merchantHashedReq = easypaisaHashedRequest(fields, this.options.hashKey);

    // Empty optional fields are left out of the form, matching the hash.
    const posted = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ''));
    const url = `${this.base}/easypay/Index.jsf`;
    return { url, fields: posted, html: autoSubmitForm(url, posted, 'Pay with Easypaisa') };
  }

  /**
   * Step 2: when Easypaisa sends the customer to postBackUrl with ?auth_token=..., return this
   * page. It posts the token back and the customer finishes paying. The final redirect goes to
   * the postBackUrl you pass here, with ?status=...&orderRefNumber=...
   */
  confirmCheckout(authToken: string, postBackUrl: string): EasypaisaCheckout {
    if (!authToken) throw new ValidationError('authToken', 'is required');
    const url = `${this.base}/easypay/Confirm.jsf`;
    const fields = { auth_token: authToken, postBackURL: postBackUrl };
    return { url, fields, html: autoSubmitForm(url, fields, 'Continue to Easypaisa') };
  }

  /**
   * Reads the final redirect (?status=0000&desc=...&orderRefNumber=...).
   * These values are NOT signed, so anyone can fake them. Use the result to show a message,
   * and call inquire() before marking the order paid.
   */
  readReturn(query: URLSearchParams | Record<string, unknown>): { orderId: string; status: string; description: string; verified: false } {
    const q = toRecord(query);
    return { orderId: q.orderRefNumber ?? '', status: q.status ?? '', description: q.desc ?? '', verified: false };
  }

  /**
   * Charges an Easypaisa mobile account. The customer approves on their phone,
   * so this can take up to a minute to return.
   */
  async chargeWallet(input: EasypaisaWalletInput): Promise<PaymentResult> {
    orderId(input.orderId);
    if (!/^03\d{9}$/.test(input.mobile)) throw new ValidationError('mobile', 'must be 03XXXXXXXXX');

    const data = await this.rest('initiate-ma-transaction', {
      orderId: input.orderId,
      storeId: this.options.storeId,
      transactionAmount: formatAmount(input.amount),
      transactionType: 'MA',
      mobileAccountNo: input.mobile,
      emailAddress: input.email,
    });
    const code = str(data.responseCode);
    return {
      gateway: 'easypaisa',
      status: code === '0000' ? 'paid' : 'failed',
      orderId: str(data.orderId) || input.orderId,
      code,
      message: str(data.responseDesc),
      ...(data.transactionId ? { transactionId: str(data.transactionId) } : {}),
      raw: data,
    };
  }

  /** Creates a voucher the customer pays in cash at any Easypaisa shop. */
  async createVoucher(input: EasypaisaVoucherInput): Promise<EasypaisaVoucher> {
    orderId(input.orderId);
    const now = input.now ?? new Date();
    const data = await this.rest('initiate-otc-transaction', {
      orderId: input.orderId,
      storeId: this.options.storeId,
      transactionAmount: formatAmount(input.amount),
      transactionType: 'OTC',
      msisdn: input.mobile,
      emailAddress: input.email,
      tokenExpiry: formatExpiry(addHours(now, input.expiresInHours ?? 72)),
    });
    const code = str(data.responseCode);
    return {
      gateway: 'easypaisa',
      status: code === '0000' ? 'pending' : 'failed',
      orderId: str(data.orderId) || input.orderId,
      code,
      message: str(data.responseDesc),
      ...(data.paymentToken ? { paymentToken: str(data.paymentToken) } : {}),
      raw: data,
    };
  }

  /** The real state of an order. The only result you should trust before fulfilling. */
  async inquire(order: string): Promise<PaymentResult> {
    orderId(order);
    if (!this.options.accountNumber) throw new ValidationError('accountNumber', 'is required for inquire()');

    const data = await this.rest('inquire-transaction', {
      orderId: order,
      storeId: this.options.storeId,
      accountNum: this.options.accountNumber,
    });
    return this.inquiryResult(order, data);
  }

  /**
   * Easypaisa's IPN calls your URL with ?url=<link to the transaction details>.
   * This fetches that link (only from an easypaisa.com.pk host) and returns the result.
   */
  async handleIpn(ipnUrl: string): Promise<PaymentResult> {
    let url: URL;
    try {
      url = new URL(ipnUrl);
    } catch {
      throw new ValidationError('url', 'is not a valid URL');
    }
    if (url.protocol !== 'https:' || !IPN_HOST.test(url.hostname)) {
      throw new ValidationError('url', `must be an https link on easypaisa.com.pk, got ${url.host}`);
    }

    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000) });
    if (!response.ok) {
      throw new PaymentError('easypaisa', `IPN details returned HTTP ${response.status}`, { httpStatus: response.status });
    }
    const data = (await response.json()) as Record<string, unknown>;
    const order = str(data.order_id ?? data.orderId) || decodeURIComponent(url.pathname.split('/').pop() ?? '');
    return this.inquiryResult(order, data);
  }

  private inquiryResult(order: string, data: Record<string, unknown>): PaymentResult {
    const code = str(data.responseCode ?? data.response_code);
    const state = str(data.transactionStatus ?? data.transaction_status ?? data.paid_status).toUpperCase();
    const amount = Number(data.transactionAmount ?? data.transaction_amount);

    let status: PaymentStatus = INQUIRY_STATUS[state] ?? 'unknown';
    if (code && code !== '0000') status = 'unknown';

    return {
      gateway: 'easypaisa',
      status,
      orderId: order,
      code: code || state,
      message: str(data.responseDesc ?? data.description) || state,
      ...(data.transactionId || data.transaction_id ? { transactionId: str(data.transactionId ?? data.transaction_id) } : {}),
      ...(Number.isFinite(amount) ? { amount } : {}),
      raw: data,
    };
  }

  private async rest(endpoint: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const { username, password } = this.options;
    if (!username || !password) throw new ValidationError('username', 'username and password are required for API calls');

    return postJson('easypaisa', `${this.base}/easypay-service/rest/v4/${endpoint}`, body, {
      ...this.options,
      headers: { Credentials: Buffer.from(`${username}:${password}`).toString('base64') },
    });
  }
}

/** Easypaisa wants a decimal point: 1000 → "1000.0", 99.5 → "99.50". */
export function formatAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('amount', 'must be greater than 0');
  const fixed = (Math.round(Number((amount * 100).toPrecision(15))) / 100).toFixed(2);
  return fixed.endsWith('.00') ? fixed.slice(0, -1) : fixed;
}

/** yyyyMMdd HHmmss in Pakistan time. */
export function formatExpiry(date: Date): string {
  const p = pktParts(date);
  return `${p.yyyy}${p.MM}${p.dd} ${p.HH}${p.mm}${p.ss}`;
}

function orderId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(String(value ?? ''))) {
    throw new ValidationError('orderId', 'must be 1 to 50 letters, digits, dashes or underscores');
  }
}
