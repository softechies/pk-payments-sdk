/**
 * Next.js App Router route handlers (also works in any framework that uses Request/Response:
 * Remix, Hono, SvelteKit, Bun). Copy the parts you need into app/api/pay/... files.
 *
 * Keep amounts on the server: look the order up by id, never trust a price sent by the browser.
 */
import { EasypaisaClient, JazzCashClient, PaymentError } from '../src/index.js';

const jazzcash = new JazzCashClient({
  merchantId: process.env.JAZZCASH_MERCHANT_ID!,
  password: process.env.JAZZCASH_PASSWORD!,
  integritySalt: process.env.JAZZCASH_INTEGRITY_SALT!,
  environment: process.env.NODE_ENV === 'production' ? 'live' : 'sandbox',
  returnUrl: `${process.env.SITE_URL}/api/pay/jazzcash/return`,
});

const easypaisa = new EasypaisaClient({
  storeId: process.env.EASYPAISA_STORE_ID!,
  hashKey: process.env.EASYPAISA_HASH_KEY!,
  username: process.env.EASYPAISA_USERNAME!,
  password: process.env.EASYPAISA_PASSWORD!,
  accountNumber: process.env.EASYPAISA_ACCOUNT_NUMBER!,
  environment: process.env.NODE_ENV === 'production' ? 'live' : 'sandbox',
});

// Stand-ins for your own database code.
declare function findOrder(id: string): Promise<{ id: string; total: number; email: string }>;
declare function markPaid(orderId: string, gateway: string, transactionId?: string): Promise<void>;
declare function savePaymentAttempt(orderId: string, reference: string): Promise<void>;
declare function orderIdForReference(reference: string): Promise<string>;

const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// GET /api/pay/jazzcash?order=1042  → redirects the customer to JazzCash
export async function startJazzCash(request: Request): Promise<Response> {
  const order = await findOrder(new URL(request.url).searchParams.get('order')!);
  const checkout = jazzcash.createCheckout({
    amount: order.total,
    billReference: order.id,
    description: `Order ${order.id}`,
  });
  await savePaymentAttempt(order.id, checkout.txnRefNo);
  return html(checkout.html);
}

// POST /api/pay/jazzcash/return  ← JazzCash sends the customer back here
export async function jazzCashReturn(request: Request): Promise<Response> {
  try {
    const result = jazzcash.verifyReturn(new URLSearchParams(await request.text()));
    const orderId = await orderIdForReference(result.orderId);
    if (result.status === 'paid') await markPaid(orderId, 'jazzcash', result.transactionId);
    return Response.redirect(`${process.env.SITE_URL}/orders/${orderId}?payment=${result.status}`, 303);
  } catch (error) {
    if (error instanceof PaymentError) return new Response('Invalid payment response', { status: 400 });
    throw error;
  }
}

// GET /api/pay/easypaisa?order=1042  → step 1
export async function startEasypaisa(request: Request): Promise<Response> {
  const order = await findOrder(new URL(request.url).searchParams.get('order')!);
  const checkout = easypaisa.createCheckout({
    amount: order.total,
    orderId: order.id,
    email: order.email,
    postBackUrl: `${process.env.SITE_URL}/api/pay/easypaisa/callback`,
  });
  return html(checkout.html);
}

// GET /api/pay/easypaisa/callback  ← step 2 (auth_token) and the final redirect (status)
export async function easypaisaCallback(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const authToken = params.get('auth_token');
  if (authToken) {
    return html(easypaisa.confirmCheckout(authToken, `${process.env.SITE_URL}/api/pay/easypaisa/callback`).html);
  }

  // The redirect itself isn't signed, so ask Easypaisa before marking anything paid.
  const { orderId } = easypaisa.readReturn(params);
  const result = await easypaisa.inquire(orderId);
  if (result.status === 'paid') await markPaid(orderId, 'easypaisa', result.transactionId);
  return Response.redirect(`${process.env.SITE_URL}/orders/${orderId}?payment=${result.status}`, 303);
}

// GET /api/pay/easypaisa/ipn?url=...  ← Easypaisa server notification
export async function easypaisaIpn(request: Request): Promise<Response> {
  const result = await easypaisa.handleIpn(new URL(request.url).searchParams.get('url') ?? '');
  if (result.status === 'paid') await markPaid(result.orderId, 'easypaisa', result.transactionId);
  return new Response('OK');
}
