import { describe, expect, it } from 'vitest';
import { JazzCashClient, PaymentError, ValidationError, jazzCashSecureHash, toPaisa } from '../src/index.js';
import { mockFetch } from './mock-fetch.js';

const SALT = 's4lt8ab3xy';
const NOW = new Date('2026-10-10T17:30:00Z'); // 22:30 in Pakistan

function client(fetchImpl?: typeof fetch) {
  return new JazzCashClient({
    merchantId: 'MC12345',
    password: 'pa55word',
    integritySalt: SALT,
    returnUrl: 'https://shop.example.com/pay/jazzcash/return',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/** Signs a gateway response the way JazzCash would, for callback tests. */
function signed(fields: Record<string, string>): Record<string, string> {
  return { ...fields, pp_SecureHash: jazzCashSecureHash(fields, SALT) };
}

describe('secure hash', () => {
  it('matches an independent HMAC-SHA256 implementation, including Latin-1 text', () => {
    // Expected value computed with Python's hmac module from the same fields.
    const checkout = client().createCheckout({
      amount: 1250.5,
      billReference: 'ORDER1042',
      description: 'Order 1042 from Café Shop',
      txnRefNo: 'T20261010223000001',
      custom: ['cust-77'],
      now: NOW,
    });
    expect(checkout.fields.pp_SecureHash).toBe('1169CB8CCE1C699C580FBF8E2142551857CBAEA28951BBCBB7D34BD03107389D');
  });

  it('refuses text JazzCash cannot sign', () => {
    expect(() =>
      client().createCheckout({ amount: 100, billReference: 'A1', description: 'آرڈر نمبر', now: NOW }),
    ).toThrow(ValidationError);
  });
});

describe('createCheckout', () => {
  const checkout = client().createCheckout({
    amount: 1250.5,
    billReference: 'ORDER1042',
    description: 'Order 1042',
    txnRefNo: 'T20261010223000001',
    now: NOW,
  });

  it('builds the hosted form fields', () => {
    expect(checkout.url).toBe('https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/');
    expect(checkout.fields).toMatchObject({
      pp_Version: '1.1',
      pp_TxnType: '',
      pp_MerchantID: 'MC12345',
      pp_Amount: '125050',
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: '20261010223000',
      pp_TxnExpiryDateTime: '20261011223000',
      pp_BillReference: 'ORDER1042',
      pp_ReturnURL: 'https://shop.example.com/pay/jazzcash/return',
      ppmpf_1: '',
    });
    expect(checkout.txnRefNo).toBe('T20261010223000001');
  });

  it('returns a self-submitting page with every field escaped', () => {
    expect(checkout.html).toContain('action="https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/"');
    expect(checkout.html).toContain('name="pp_SecureHash"');
    expect(checkout.html).toContain('.submit()');
  });

  it('uses the live host and generates references', () => {
    const live = new JazzCashClient({ merchantId: 'M', password: 'P', integritySalt: 'S', environment: 'live', returnUrl: 'https://x.test/r' });
    const c = live.createCheckout({ amount: 10, billReference: 'B1', description: 'Test', now: NOW });
    expect(c.url.startsWith('https://payments.jazzcash.com.pk/')).toBe(true);
    expect(c.txnRefNo).toMatch(/^T20261010223000\d{3}$/);
  });

  it('validates input', () => {
    expect(() => client().createCheckout({ amount: 0, billReference: 'B1', description: 'x' })).toThrow('amount');
    expect(() => client().createCheckout({ amount: 10, billReference: 'ORDER-1', description: 'x' })).toThrow('billReference');
    expect(() => new JazzCashClient({ merchantId: '', password: 'p', integritySalt: 's' })).toThrow('merchantId');
  });
});

describe('toPaisa', () => {
  it.each([
    [1, '100'],
    [1250.5, '125050'],
    [0.29, '29'],
    [19.99, '1999'],
  ])('%d rupees → %s', (rupees, paisa) => {
    expect(toPaisa(rupees)).toBe(paisa);
  });
});

describe('verifyReturn', () => {
  const base = {
    pp_TxnRefNo: 'T20261010223000001',
    pp_Amount: '125050',
    pp_ResponseMessage: 'Thank you for Using JazzCash, your transaction was successful.',
    pp_RetreivalReferenceNo: '261010987654',
  };

  it('accepts a correctly signed success', () => {
    const result = client().verifyReturn(new URLSearchParams(signed({ ...base, pp_ResponseCode: '000' })));
    expect(result).toMatchObject({ status: 'paid', orderId: 'T20261010223000001', code: '000', amount: 1250.5, transactionId: '261010987654' });
  });

  it('maps voucher and pending codes', () => {
    expect(client().verifyReturn(signed({ ...base, pp_ResponseCode: '124' })).status).toBe('pending');
    expect(client().verifyReturn(signed({ ...base, pp_ResponseCode: '157' })).status).toBe('pending');
    expect(client().verifyReturn(signed({ ...base, pp_ResponseCode: '199' })).status).toBe('failed');
  });

  it('rejects a tampered amount', () => {
    const fields = signed({ ...base, pp_ResponseCode: '000' });
    fields.pp_Amount = '100';
    expect(() => client().verifyReturn(fields)).toThrow(PaymentError);
  });

  it('rejects a callback without a hash', () => {
    expect(() => client().verifyReturn({ ...base, pp_ResponseCode: '000' })).toThrow('Secure hash');
  });

  it('signs the IPN acknowledgement', () => {
    expect(client().ipnAcknowledgement()).toEqual({
      pp_ResponseCode: '000',
      pp_ResponseMessage: 'IPN received',
      pp_SecureHash: '7B6112B8EDA74C483D249FB354B317D464F1E2AE5ABD077B4EC77C6EC45A8667',
    });
  });
});

describe('inquire', () => {
  const completed = {
    pp_ResponseCode: '000',
    pp_ResponseMessage: 'Operation completed successfully.',
    pp_PaymentResponseCode: '121',
    pp_PaymentResponseMessage: 'Transaction completed successfully',
    pp_Status: 'Completed',
    pp_TxnRefNo: 'T20261010223000001',
    pp_Amount: '125050',
    pp_RetreivalReferenceNo: '261010987654',
  };

  it('posts a signed inquiry and reads a completed payment', async () => {
    const mock = mockFetch({ json: { ...completed, pp_SecureHash: '1EB9D1784EFEFF4D108F518E3D1A75E89012EE5CFCEF8165E342AC3E522461A5' } });
    const result = await client(mock.fetch).inquire('T20261010223000001');

    expect(mock.calls[0]!.url).toBe('https://sandbox.jazzcash.com.pk/ApplicationAPI/API/PaymentInquiry/Inquire');
    expect(mock.calls[0]!.body).toMatchObject({ pp_TxnRefNo: 'T20261010223000001', pp_MerchantID: 'MC12345', pp_Password: 'pa55word' });
    expect(mock.calls[0]!.body.pp_SecureHash).toMatch(/^[0-9A-F]{64}$/);
    expect(result).toMatchObject({ status: 'paid', code: '121', amount: 1250.5 });
  });

  it('treats an unknown reference as unknown, not failed', async () => {
    const mock = mockFetch({ json: signed({ pp_ResponseCode: '000', pp_PaymentResponseCode: '999', pp_ResponseMessage: 'ok' }) });
    expect((await client(mock.fetch).inquire('T1')).status).toBe('unknown');
  });

  it('rejects a response with a bad hash', async () => {
    const mock = mockFetch({ json: { ...completed, pp_SecureHash: 'DEADBEEF' } });
    await expect(client(mock.fetch).inquire('T1')).rejects.toThrow('Response secure hash');
  });

  it('reports gateway errors', async () => {
    const mock = mockFetch({ status: 500, text: 'Internal Server Error' });
    await expect(client(mock.fetch).inquire('T1')).rejects.toMatchObject({ httpStatus: 500 });
  });
});

describe('chargeWallet', () => {
  it('sends a mobile wallet charge', async () => {
    const mock = mockFetch({ json: signed({ pp_ResponseCode: '000', pp_ResponseMessage: 'Thank you', pp_TxnRefNo: 'T9', pp_RetreivalReferenceNo: '555' }) });
    const result = await client(mock.fetch).chargeWallet({
      amount: 500,
      billReference: 'ORDER9',
      description: 'Order 9',
      mobileNumber: '03123456789',
      cnicLast6: '345678',
      txnRefNo: 'T9',
      now: NOW,
    });

    expect(mock.calls[0]!.url).toBe('https://sandbox.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction');
    expect(mock.calls[0]!.body).toMatchObject({ pp_MobileNumber: '03123456789', pp_CNIC: '345678', pp_Amount: '50000' });
    expect(result).toMatchObject({ status: 'paid', transactionId: '555' });
  });

  it('validates the wallet details first', async () => {
    const mock = mockFetch();
    await expect(
      client(mock.fetch).chargeWallet({ amount: 1, billReference: 'A', description: 'x', mobileNumber: '3001234567', cnicLast6: '123456' }),
    ).rejects.toThrow('mobileNumber');
    expect(mock.calls).toHaveLength(0);
  });
});
