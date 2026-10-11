import { describe, expect, it } from 'vitest';
import { EasypaisaClient, ValidationError, easypaisaAmount, easypaisaHashedRequest } from '../src/index.js';
import { mockFetch } from './mock-fetch.js';

const NOW = new Date('2026-10-10T17:30:00Z'); // 22:30 in Pakistan

function client(fetchImpl?: typeof fetch) {
  return new EasypaisaClient({
    storeId: '43210',
    hashKey: 'K9xT2mQ7pL4vB8zR',
    username: 'apiuser',
    password: 'apipass',
    accountNumber: '654321',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

const checkoutFields = {
  amount: '1250.5',
  autoRedirect: '1',
  emailAddr: 'ayesha@example.com',
  expiryDate: '20261011 223000',
  mobileNum: '03451234567',
  orderRefNum: 'ORDER-1042',
  postBackURL: 'https://shop.example.com/pay/easypaisa',
  storeId: '43210',
};

describe('merchantHashedReq', () => {
  // Expected values produced with `openssl enc -aes-128-ecb` / `-aes-256-ecb` on the same string.
  it('matches OpenSSL AES-128-ECB', () => {
    expect(easypaisaHashedRequest(checkoutFields, 'K9xT2mQ7pL4vB8zR')).toBe(
      'QMlKzkKaWI4IWAzeVasTk7DrvLesXJ890UqjKsyg1xd3gQFuKnVSank8yw2tlqDRulVwbMZHYulylzplX2y34sDDzKdluJMUhrK+vCIKboeytZszdKemwSX6qQxOSNXO925Ge+E27tP2foP2sopycPZqEAnhtgl2Vl7voDTGj8nHCVxBBvoAEux6tqpfhMj23MyKN+rMD8jT1z1onx/hHB7+a5WbEKkO70uVRncMDTuAkiCLoOwjYk5ImSzdmjHQ/R+9E0g4RvcaV/y5Ez1t6Q==',
    );
  });

  it('matches OpenSSL AES-256-ECB for 32 character keys', () => {
    expect(easypaisaHashedRequest(checkoutFields, 'K9xT2mQ7pL4vB8zRK9xT2mQ7pL4vB8zR')).toBe(
      'Tudv76nY/yaPChnwsO6YAbD9cTOsvtY7KE38bLw7Mppu7koAXwjIFp8WKkF/Q4zZZh4i6q/pI58iYRM760i7JyVHOi36D+roA3AjKwsa2l++V94265AKE8rDjXH3qK9WEoU5Tn+sZN43YJ3Ee7xqowzEOWu7hezEb8hjICWDwccycUejMCfKnEeNQN2v6KYZg2Hgi3zZ8DGWek4ViqkGU3mSU/idy9tq23Xqr3m25GHHPee+DUs9o6aT561CKtKAOHQGyVOD1t1IaoTRsJB54g==',
    );
  });

  it('rejects keys of the wrong length', () => {
    expect(() => easypaisaHashedRequest(checkoutFields, 'short')).toThrow(ValidationError);
  });
});

describe('createCheckout', () => {
  it('builds the Index.jsf form with the hash over the same values', () => {
    const checkout = client().createCheckout({
      amount: 1250.5,
      orderId: 'ORDER-1042',
      postBackUrl: 'https://shop.example.com/pay/easypaisa',
      email: 'ayesha@example.com',
      mobile: '03451234567',
      now: NOW,
    });

    expect(checkout.url).toBe('https://easypaystg.easypaisa.com.pk/easypay/Index.jsf');
    const expected = { ...checkoutFields, amount: '1250.50' };
    expect(checkout.fields).toEqual({ ...expected, merchantHashedReq: easypaisaHashedRequest(expected, 'K9xT2mQ7pL4vB8zR') });
    expect(checkout.html).toContain('name="merchantHashedReq"');
  });

  it('leaves out empty optional fields', () => {
    const checkout = client().createCheckout({ amount: 99, orderId: 'A1', postBackUrl: 'https://x.test/cb', now: NOW });
    expect(Object.keys(checkout.fields)).not.toContain('emailAddr');
    expect(Object.keys(checkout.fields)).not.toContain('paymentMethod');
    expect(checkout.fields.amount).toBe('99.0');
  });

  it('builds the confirm step', () => {
    const confirm = client().confirmCheckout('tok123', 'https://shop.example.com/pay/easypaisa/done');
    expect(confirm.url).toBe('https://easypaystg.easypaisa.com.pk/easypay/Confirm.jsf');
    expect(confirm.fields).toEqual({ auth_token: 'tok123', postBackURL: 'https://shop.example.com/pay/easypaisa/done' });
  });

  it('marks the final redirect as unverified', () => {
    expect(client().readReturn(new URLSearchParams('status=0000&desc=Success&orderRefNumber=A1'))).toEqual({
      orderId: 'A1',
      status: '0000',
      description: 'Success',
      verified: false,
    });
  });
});

describe('easypaisaAmount', () => {
  it.each([
    [1000, '1000.0'],
    [99.5, '99.50'],
    [10.25, '10.25'],
    [0.1 + 0.2, '0.30'],
  ])('%d → %s', (amount, text) => {
    expect(easypaisaAmount(amount)).toBe(text);
  });
});

describe('REST calls', () => {
  it('charges a wallet with the Credentials header', async () => {
    const mock = mockFetch({
      json: { orderId: 'ORDER-9', storeId: '43210', transactionId: '1122334455', transactionDateTime: '10/10/2026 10:31 PM', responseCode: '0000', responseDesc: 'SUCCESS' },
    });
    const result = await client(mock.fetch).chargeWallet({ amount: 500, orderId: 'ORDER-9', mobile: '03451234567', email: 'a@b.test' });

    const call = mock.calls[0]!;
    expect(call.url).toBe('https://easypaystg.easypaisa.com.pk/easypay-service/rest/v4/initiate-ma-transaction');
    expect(call.headers.Credentials).toBe(Buffer.from('apiuser:apipass').toString('base64'));
    expect(call.body).toEqual({
      orderId: 'ORDER-9',
      storeId: '43210',
      transactionAmount: '500.0',
      transactionType: 'MA',
      mobileAccountNo: '03451234567',
      emailAddress: 'a@b.test',
    });
    expect(result).toMatchObject({ status: 'paid', transactionId: '1122334455', code: '0000' });
  });

  it('reports a declined wallet charge', async () => {
    const mock = mockFetch({ json: { responseCode: '0013', responseDesc: 'LOW BALANCE' } });
    const result = await client(mock.fetch).chargeWallet({ amount: 500, orderId: 'ORDER-9', mobile: '03451234567', email: 'a@b.test' });
    expect(result).toMatchObject({ status: 'failed', code: '0013', message: 'LOW BALANCE' });
  });

  it('creates a voucher', async () => {
    const mock = mockFetch({ json: { responseCode: '0000', responseDesc: 'SUCCESS', orderId: 'V1', paymentToken: '58749123' } });
    const voucher = await client(mock.fetch).createVoucher({ amount: 1500, orderId: 'V1', mobile: '03451234567', email: 'a@b.test', now: NOW });
    expect(mock.calls[0]!.body).toMatchObject({ transactionType: 'OTC', msisdn: '03451234567', tokenExpiry: '20261013 223000' });
    expect(voucher).toMatchObject({ status: 'pending', paymentToken: '58749123' });
  });

  it.each([
    ['PAID', 'paid'],
    ['PENDING', 'pending'],
    ['EXPIRED', 'failed'],
    ['REVERSED', 'failed'],
    ['SOMETHING_NEW', 'unknown'],
  ])('inquiry status %s → %s', async (transactionStatus, expected) => {
    const mock = mockFetch({ json: { responseCode: '0000', transactionStatus, transactionAmount: 1250.5, orderId: 'A1' } });
    const result = await client(mock.fetch).inquire('A1');
    expect(mock.calls[0]!.body).toEqual({ orderId: 'A1', storeId: '43210', accountNum: '654321' });
    expect(result.status).toBe(expected);
  });

  it('needs API credentials', async () => {
    const noCreds = new EasypaisaClient({ storeId: '1', accountNumber: '2' });
    await expect(noCreds.inquire('A1')).rejects.toThrow('username');
  });
});

describe('handleIpn', () => {
  it('fetches details only from easypaisa.com.pk', async () => {
    const mock = mockFetch({ json: { order_id: 'A1', transaction_status: 'PAID', transaction_amount: '1250.5', transaction_id: '777' } });
    const result = await client(mock.fetch).handleIpn('https://easypay.easypaisa.com.pk/easypay-service/rest/v1/order-status/A1');
    expect(result).toMatchObject({ status: 'paid', orderId: 'A1', amount: 1250.5, transactionId: '777' });
  });

  it.each(['https://evil.example.com/A1', 'http://easypay.easypaisa.com.pk/A1', 'https://easypaisa.com.pk.evil.test/A1', 'not a url'])(
    'refuses %s',
    async (url) => {
      const mock = mockFetch();
      await expect(client(mock.fetch).handleIpn(url)).rejects.toThrow(ValidationError);
      expect(mock.calls).toHaveLength(0);
    },
  );
});
