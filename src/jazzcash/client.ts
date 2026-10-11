import { randomInt } from 'node:crypto';
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
import { assertLatin1, jazzCashSecureHash, verifyJazzCashHash } from './hash.js';

export interface JazzCashOptions extends HttpOptions {
  merchantId: string;
  password: string;
  integritySalt: string;
  /** "sandbox" or "live". Default sandbox. */
  environment?: 'sandbox' | 'live';
  /** Where JazzCash sends the customer back (by POST). Must match the URL in your JazzCash profile exactly. */
  returnUrl?: string;
  /** Override the gateway host, e.g. for a local simulator. */
  baseUrl?: string;
}

/** Limit the hosted page to one method. Leave empty to let the customer choose. */
export type JazzCashTxnType = '' | 'MWALLET' | 'MPAY' | 'OTC';

export interface JazzCashCheckoutInput {
  /** Amount in rupees. Sent to JazzCash in paisa. */
  amount: number;
  /** Your order number. Letters and digits only. */
  billReference: string;
  description: string;
  /** Unique per attempt, max 20 characters. Generated when left out. */
  txnRefNo?: string;
  txnType?: JazzCashTxnType;
  /** How long the payment stays open, in hours. Default 24. */
  expiresInHours?: number;
  returnUrl?: string;
  /** Up to 5 custom values that come back unchanged (ppmpf_1..ppmpf_5). */
  custom?: [string?, string?, string?, string?, string?];
  /** For tests. */
  now?: Date;
}

export interface JazzCashCheckout {
  /** Gateway page to POST the fields to. */
  url: string;
  fields: Record<string, string>;
  /** Self-submitting HTML page; send it as the response to redirect the customer. */
  html: string;
  txnRefNo: string;
}

export interface JazzCashWalletInput {
  amount: number;
  billReference: string;
  description: string;
  /** Customer's JazzCash mobile account, 03XXXXXXXXX. */
  mobileNumber: string;
  /** Last 6 digits of the customer's CNIC. */
  cnicLast6: string;
  txnRefNo?: string;
  expiresInHours?: number;
  now?: Date;
}

const HOSTS = {
  sandbox: 'https://sandbox.jazzcash.com.pk',
  live: 'https://payments.jazzcash.com.pk',
};

const PATHS = {
  checkout: '/CustomerPortal/transactionmanagement/merchantform/',
  wallet: '/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction',
  inquiry: '/ApplicationAPI/API/PaymentInquiry/Inquire',
};

/** Codes that mean "not finished yet". 124: voucher issued, to be paid at a shop. 157: waiting for the customer. */
const PENDING_CODES = new Set(['124', '157']);

export class JazzCashClient {
  private readonly base: string;

  constructor(private readonly options: JazzCashOptions) {
    for (const key of ['merchantId', 'password', 'integritySalt'] as const) {
      if (!options[key]) throw new ValidationError(key, 'is required');
    }
    this.base = (options.baseUrl ?? HOSTS[options.environment ?? 'sandbox']).replace(/\/$/, '');
  }

  /**
   * Builds the hosted checkout form. Send `html` back from your route and the customer lands on
   * the JazzCash page, pays, and comes back to returnUrl with the result (check it with verifyReturn).
   */
  createCheckout(input: JazzCashCheckoutInput): JazzCashCheckout {
    const returnUrl = input.returnUrl ?? this.options.returnUrl;
    if (!returnUrl) throw new ValidationError('returnUrl', 'is required');

    const now = input.now ?? new Date();
    const txnRefNo = input.txnRefNo ?? generateTxnRefNo(now);
    const fields: Record<string, string> = {
      pp_Version: '1.1',
      pp_TxnType: input.txnType ?? '',
      pp_Language: 'EN',
      pp_MerchantID: this.options.merchantId,
      pp_SubMerchantID: '',
      pp_Password: this.options.password,
      pp_BankID: '',
      pp_ProductID: '',
      pp_TxnRefNo: txnRefNo,
      pp_Amount: toPaisa(input.amount),
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: formatDateTime(now),
      pp_BillReference: billReference(input.billReference),
      pp_Description: description(input.description),
      pp_TxnExpiryDateTime: formatDateTime(addHours(now, input.expiresInHours ?? 24)),
      pp_ReturnURL: returnUrl,
      ...customFields(input.custom),
    };
    validateTxnRefNo(txnRefNo);
    fields.pp_SecureHash = jazzCashSecureHash(fields, this.options.integritySalt);

    const url = this.base + PATHS.checkout;
    return { url, fields, html: autoSubmitForm(url, fields, 'Pay with JazzCash'), txnRefNo };
  }

  /**
   * Checks the POST JazzCash sends to your return URL (or an IPN) and turns it into a result.
   * Throws if the secure hash doesn't match, so forged callbacks never reach your order logic.
   */
  verifyReturn(body: URLSearchParams | FormData | Record<string, unknown>): PaymentResult {
    const fields = toRecord(body);
    if (!verifyJazzCashHash(fields, this.options.integritySalt)) {
      throw new PaymentError('jazzcash', 'Secure hash does not match: the callback was not sent by JazzCash or was changed', { raw: fields });
    }

    const code = fields.pp_ResponseCode ?? '';
    return {
      gateway: 'jazzcash',
      status: code === '000' ? 'paid' : PENDING_CODES.has(code) ? 'pending' : 'failed',
      orderId: fields.pp_TxnRefNo ?? '',
      code,
      message: fields.pp_ResponseMessage ?? '',
      ...(fields.pp_RetreivalReferenceNo ? { transactionId: fields.pp_RetreivalReferenceNo } : {}),
      ...(fields.pp_Amount ? { amount: Number(fields.pp_Amount) / 100 } : {}),
      raw: fields,
    };
  }

  /**
   * Body to answer a JazzCash IPN with, after verifyReturn() succeeded and you stored the result.
   */
  ipnAcknowledgement(message = 'IPN received'): Record<string, string> {
    const body: Record<string, string> = { pp_ResponseCode: '000', pp_ResponseMessage: message };
    return { ...body, pp_SecureHash: jazzCashSecureHash(body, this.options.integritySalt) };
  }

  /**
   * Charges a JazzCash mobile account directly (no redirect). The customer approves the payment
   * with their MPIN on their phone, so this can take up to a minute to return.
   */
  async chargeWallet(input: JazzCashWalletInput): Promise<PaymentResult> {
    if (!/^03\d{9}$/.test(input.mobileNumber)) throw new ValidationError('mobileNumber', 'must be 03XXXXXXXXX');
    if (!/^\d{6}$/.test(input.cnicLast6)) throw new ValidationError('cnicLast6', 'must be the last 6 digits of the CNIC');

    const now = input.now ?? new Date();
    const txnRefNo = input.txnRefNo ?? generateTxnRefNo(now);
    validateTxnRefNo(txnRefNo);
    const fields: Record<string, string> = {
      pp_Language: 'EN',
      pp_MerchantID: this.options.merchantId,
      pp_SubMerchantID: '',
      pp_Password: this.options.password,
      pp_BankID: '',
      pp_ProductID: '',
      pp_TxnRefNo: txnRefNo,
      pp_Amount: toPaisa(input.amount),
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: formatDateTime(now),
      pp_BillReference: billReference(input.billReference),
      pp_Description: description(input.description),
      pp_TxnExpiryDateTime: formatDateTime(addHours(now, input.expiresInHours ?? 24)),
      pp_MobileNumber: input.mobileNumber,
      pp_CNIC: input.cnicLast6,
      ...customFields(undefined),
    };
    fields.pp_SecureHash = jazzCashSecureHash(fields, this.options.integritySalt);

    // Payments are never retried automatically: a timeout may still have charged the customer.
    const data = await postJson('jazzcash', this.base + PATHS.wallet, fields, this.options);
    return this.toResult(data, txnRefNo);
  }

  /**
   * Asks JazzCash for the real state of a transaction. Use it for pending payments,
   * after timeouts, and in a scheduled job that reconciles open orders.
   */
  async inquire(txnRefNo: string): Promise<PaymentResult> {
    validateTxnRefNo(txnRefNo);
    const fields: Record<string, string> = {
      pp_TxnRefNo: txnRefNo,
      pp_MerchantID: this.options.merchantId,
      pp_Password: this.options.password,
    };
    fields.pp_SecureHash = jazzCashSecureHash(fields, this.options.integritySalt);

    const data = await postJson('jazzcash', this.base + PATHS.inquiry, fields, this.options);
    const record = toRecord(data);
    this.checkResponseHash(record);

    const code = record.pp_ResponseCode ?? '';
    const paymentCode = record.pp_PaymentResponseCode ?? '';
    let status: PaymentStatus;
    if (code !== '000') status = 'unknown'; // the inquiry itself failed
    else if (paymentCode === '121' || /^completed$/i.test(record.pp_Status ?? '')) status = 'paid';
    else if (paymentCode === '999') status = 'unknown'; // no transaction with this reference
    else if (PENDING_CODES.has(paymentCode) || /pending/i.test(record.pp_Status ?? '')) status = 'pending';
    else status = 'failed';

    return {
      gateway: 'jazzcash',
      status,
      orderId: txnRefNo,
      code: paymentCode || code,
      message: record.pp_PaymentResponseMessage || record.pp_ResponseMessage || '',
      ...(record.pp_RetreivalReferenceNo ? { transactionId: record.pp_RetreivalReferenceNo } : {}),
      ...(record.pp_Amount ? { amount: Number(record.pp_Amount) / 100 } : {}),
      raw: data,
    };
  }

  private toResult(data: Record<string, unknown>, txnRefNo: string): PaymentResult {
    const record = toRecord(data);
    this.checkResponseHash(record);
    const code = str(record.pp_ResponseCode);
    return {
      gateway: 'jazzcash',
      status: code === '000' ? 'paid' : PENDING_CODES.has(code) ? 'pending' : code ? 'failed' : 'unknown',
      orderId: record.pp_TxnRefNo || txnRefNo,
      code,
      message: str(record.pp_ResponseMessage),
      ...(record.pp_RetreivalReferenceNo ? { transactionId: record.pp_RetreivalReferenceNo } : {}),
      raw: data,
    };
  }

  /** Responses carry a hash too. A mismatch means the answer didn't come from JazzCash unchanged. */
  private checkResponseHash(record: Record<string, string>): void {
    if (record.pp_SecureHash && !verifyJazzCashHash(record, this.options.integritySalt)) {
      throw new PaymentError('jazzcash', 'Response secure hash does not match', { raw: record });
    }
  }
}

/** "T" + PKT timestamp + 3 random digits, 18 characters. Unique enough for one merchant. */
export function generateTxnRefNo(now = new Date()): string {
  return `T${formatDateTime(now)}${String(randomInt(0, 1000)).padStart(3, '0')}`;
}

/** yyyyMMddHHmmss in Pakistan time. */
export function formatDateTime(date: Date): string {
  const p = pktParts(date);
  return `${p.yyyy}${p.MM}${p.dd}${p.HH}${p.mm}${p.ss}`;
}

/** Rupees to the paisa string JazzCash expects: 1250.5 → "125050". */
export function toPaisa(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('amount', 'must be greater than 0');
  const paisa = Math.round(Number((amount * 100).toPrecision(15)));
  return String(paisa);
}

function billReference(value: string): string {
  const ref = String(value ?? '').trim();
  if (!/^[A-Za-z0-9]{1,20}$/.test(ref)) {
    throw new ValidationError('billReference', 'must be 1 to 20 letters or digits (no spaces or symbols)');
  }
  return ref;
}

function description(value: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new ValidationError('description', 'is required');
  assertLatin1('description', text);
  return text.slice(0, 100);
}

function validateTxnRefNo(value: string): void {
  if (!/^[A-Za-z0-9]{1,20}$/.test(value)) {
    throw new ValidationError('txnRefNo', 'must be 1 to 20 letters or digits');
  }
}

function customFields(custom: JazzCashCheckoutInput['custom']): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    const value = custom?.[i] ?? '';
    assertLatin1(`custom[${i}]`, value);
    out[`ppmpf_${i + 1}`] = value;
  }
  return out;
}
