# pk-payments-sdk

**JazzCash and Easypaisa for Node.js and TypeScript.** Hosted checkout, mobile wallet charges,
Easypaisa shop vouchers, status inquiry and **verified** callbacks, with one status vocabulary
for both gateways.

[![ci](https://github.com/softechies/pk-payments-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/softechies/pk-payments-sdk/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

```ts
import { JazzCashClient } from 'pk-payments-sdk';

const jazzcash = new JazzCashClient({
  merchantId: process.env.JAZZCASH_MERCHANT_ID!,
  password: process.env.JAZZCASH_PASSWORD!,
  integritySalt: process.env.JAZZCASH_INTEGRITY_SALT!,
  returnUrl: 'https://shop.example.com/api/pay/jazzcash/return',
});

// Send the customer to JazzCash
const checkout = jazzcash.createCheckout({ amount: 1250.5, billReference: 'ORDER1042', description: 'Order 1042' });
return new Response(checkout.html, { headers: { 'Content-Type': 'text/html' } });

// When they come back
const result = jazzcash.verifyReturn(await request.formData()); // throws if the hash is wrong
if (result.status === 'paid') await markOrderPaid(result.orderId);
```

## Why

Both gateways work, but their integration guides are PDFs with PHP samples, and the details that
break integrations are easy to miss: JazzCash amounts in paisa, ISO-8859-1 hashing, Pakistan time
regardless of where your server runs, Easypaisa's two step redirect and AES-ECB request hash,
and the fact that Easypaisa's final redirect isn't signed at all. This package handles each of
those, and every hash is tested against an independent implementation (Python `hmac`, OpenSSL).

## Install

```bash
npm install pk-payments-sdk
```

Node 20+. No dependencies.

## Statuses

Every call returns a `PaymentResult`:

```ts
{
  gateway: 'jazzcash' | 'easypaisa',
  status: 'paid' | 'pending' | 'failed' | 'unknown',
  orderId: string,
  code: string,          // gateway code, e.g. '000' or '0000'
  message: string,
  transactionId?: string,
  amount?: number,       // rupees
  raw: unknown           // full gateway response, keep it server side
}
```

| Status | Meaning | What to do |
|---|---|---|
| `paid` | Money received | Fulfil the order |
| `pending` | Waiting for the customer, or a voucher to be paid at a shop | Wait for the IPN, or `inquire()` later |
| `failed` | Declined, cancelled or expired | Let the customer try again |
| `unknown` | No clear answer (timeout, unknown reference) | `inquire()` before doing anything |

## JazzCash

| Method | What it does |
|---|---|
| `createCheckout(input)` | Hosted payment page (wallet, card, voucher). Returns `{ url, fields, html, txnRefNo }` |
| `verifyReturn(body)` | Checks the secure hash of the return POST or IPN, then maps the result. Throws on a bad hash |
| `ipnAcknowledgement()` | Signed body to answer a JazzCash IPN with |
| `chargeWallet(input)` | Direct mobile account charge (customer approves with MPIN on their phone) |
| `inquire(txnRefNo)` | Real state of a transaction. Verifies the response hash too |

```ts
// Direct wallet charge, no redirect
const result = await jazzcash.chargeWallet({
  amount: 500,
  billReference: 'ORDER1043',
  description: 'Order 1043',
  mobileNumber: '03123456789',
  cnicLast6: '345678',
});

// Reconcile anything left pending
const check = await jazzcash.inquire('T20261010223000123');
```

Handled for you: amounts converted to paisa without float errors, `yyyyMMddHHmmss` timestamps in
Pakistan time, unique `pp_TxnRefNo` generation, `pp_BillReference` and description validation,
and a clear error instead of a rejected hash if text contains characters JazzCash can't sign
(Urdu, emoji).

## Easypaisa

| Method | What it does |
|---|---|
| `createCheckout(input)` | Step 1 of the hosted checkout (`Index.jsf`) with `merchantHashedReq` |
| `confirmCheckout(authToken, postBackUrl)` | Step 2: posts the `auth_token` back (`Confirm.jsf`) |
| `readReturn(query)` | Reads the final redirect. **Unverified**: confirm with `inquire()` |
| `chargeWallet(input)` | Direct Easypaisa mobile account charge (REST) |
| `createVoucher(input)` | Shop voucher: customer pays cash at any Easypaisa retailer |
| `inquire(orderId)` | Real state of an order |
| `handleIpn(url)` | Fetches the IPN details link, only from `https://*.easypaisa.com.pk` |

```ts
const easypaisa = new EasypaisaClient({
  storeId: '43210',
  hashKey: process.env.EASYPAISA_HASH_KEY,      // hosted checkout
  username: process.env.EASYPAISA_USERNAME,     // REST calls
  password: process.env.EASYPAISA_PASSWORD,
  accountNumber: process.env.EASYPAISA_ACCOUNT, // inquiry
});
```

The hosted flow is three hops, all through the same `postBackUrl`:

```
your server ──createCheckout──▶ Easypaisa Index.jsf
Easypaisa ──?auth_token=…──────▶ your postBackUrl ──confirmCheckout──▶ Confirm.jsf
Easypaisa ──?status=…&orderRefNumber=…──▶ your postBackUrl ──inquire()──▶ mark paid
```

## Full example

[`examples/nextjs-routes.ts`](examples/nextjs-routes.ts) has working route handlers for both
gateways (start, return, callbacks, IPN) using standard `Request`/`Response`, so they drop into
Next.js App Router, Remix, Hono, SvelteKit or Bun.

## Security checklist

- Look the amount up from your own order on the server. Never take a price from the browser.
- Mark orders paid only from `verifyReturn()` (JazzCash) or `inquire()` / `handleIpn()` (Easypaisa).
- Make your "mark paid" code idempotent: the return URL and the IPN can both arrive.
- Never auto-retry a charge that timed out. Run `inquire()` first; the customer may have paid.
- Don't log or return `raw` or checkout `fields` to the browser. JazzCash's form includes
  `pp_Password` by design, so use a dedicated gateway password and rotate it if exposed.

## Going live

1. Finish merchant onboarding with JazzCash and/or Easypaisa and get your credentials.
2. Register your return / postback and IPN URLs in their portals. They must match exactly.
3. Test in sandbox, then set `environment: 'live'`.
4. Schedule a job that calls `inquire()` for orders still `pending` or `unknown`.

Endpoints follow the merchant integration guides. Gateways change things from time to time and
merchant accounts differ in which methods are enabled, so confirm against your own guide. Every
host can be overridden with `baseUrl`.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT. Not affiliated with JazzCash or Easypaisa.

---

Built and maintained by [Softechies Solutions](https://softechies.net). See also
[pk-courier-sdk](https://github.com/softechies/pk-courier-sdk) and
[pk-validators](https://github.com/softechies/pk-validators).
